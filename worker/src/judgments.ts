// Fast, typed judgments from TypeSafe's System One models, used where code
// needs a quick decision instead of a full Claude turn:
//
//   action-risk     Before a click, Enter-submit or site action: would it
//                   commit something consequential and hard to undo, and did
//                   the user explicitly ask for exactly that? The SDK asks the
//                   user to confirm when the first is likely and the second isn't.
//   guide-progress  After the user clicks during a guide: which plan steps
//                   are now done, and has the user drifted off course? The SDK
//                   only wakes Claude when something changed.
//
// Everything here is optional: without TYPESAFE_API_KEY the route answers
// { available: false } and the SDK keeps its Claude-only behavior.

import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { SystemOneRequest, Questions, SystemOneResult } from "@typesafe-ai/sdk";

export type AskSystemOne = <const Q extends Questions>(request: SystemOneRequest<Q>) => Promise<SystemOneResult<Q>>;

const MAX_TEXT_CHARACTERS = 8000;
const MAX_PLAN_STEPS = 7;

function clip(value: unknown, maxCharacters: number): string {
  const text = String(value ?? "");
  return text.length > maxCharacters ? `${text.slice(0, maxCharacters - 1)}…` : text;
}

export function createSystemOneAsker(apiKey: string): AskSystemOne {
  // Short timeout and one retry: these judgments gate interactive steps, so a
  // slow answer is worse than falling back to Claude-only behavior.
  const typeSafeClient = new TypeSafeClient({ apiKey, timeout: 5000, retry: { maxRetries: 1 }, compression: false });
  return (request) => typeSafeClient.systemOne(request);
}

export interface ActionRiskState {
  userRequest: string;
  site: string;
  pageTitle: string;
  action: string; // "click", "press Enter in", or "run the site action"
  target: string; // the element's snapshot description, or the site action and its parameters
  surroundingText: string; // the form or section around the target
}

export async function judgeActionRisk(askSystemOne: AskSystemOne, rawState: ActionRiskState) {
  const state = {
    user_request: clip(rawState.userRequest, 1000),
    site: clip(rawState.site, 200),
    page_title: clip(rawState.pageTitle, 300),
    action: clip(rawState.action, 60),
    target: clip(rawState.target, 1000),
    surrounding_text: clip(rawState.surroundingText, 2000),
  };
  const { answers } = await askSystemOne({
    state,
    questions: {
      consequential: noul(
        "An assistant is about to perform `action` on `target` on a web page. Would doing so commit a consequential change that is hard to undo?",
        {
          true: "Yes: it completes a purchase or payment, places an order, deletes or cancels something, sends a message or email, publishes or posts content, changes account or security settings, or submits personal or contact details.",
          false: "No: it navigates, opens, expands, filters, sorts, searches, reveals information, adds to a cart without checking out, or edits something that can still be reviewed or changed before it is committed.",
        },
      ),
      explicitlyRequested: noul(
        "Does `user_request` explicitly ask for exactly the outcome that performing `action` on `target` would commit, such as \"buy it\", \"send it\" or \"delete it\", rather than only asking to find, look at, compare, explain or prepare something?",
      ),
    },
  });
  return { consequential: answers.consequential.noul, explicitlyRequested: answers.explicitlyRequested.noul };
}

export interface GuideProgressState {
  goal: string;
  steps: { number: number; text: string; done: boolean }[];
  lastUserAction: string;
  page: string; // the page snapshot text
}

export async function judgeGuideProgress(askSystemOne: AskSystemOne, rawState: GuideProgressState) {
  const steps = rawState.steps.slice(0, MAX_PLAN_STEPS).map((step) => ({
    number: Number(step.number),
    text: clip(step.text, 200),
    done: Boolean(step.done),
  }));
  const state = {
    goal: clip(rawState.goal, 300),
    plan: steps,
    last_user_action: clip(rawState.lastUserAction, 300),
    page: clip(rawState.page, MAX_TEXT_CHARACTERS),
  };

  // One independent question per open step, asked together so they run in parallel.
  const questions: Questions = {
    offTrack: noul(
      "A user is following `plan` toward `goal`. Judging by `last_user_action` and the current `page`, have they moved away from the goal, for example by leaving the flow, opening something unrelated, or undoing earlier progress?",
    ),
  };
  for (const step of steps.filter((planStep) => !planStep.done)) {
    questions[`step${step.number}`] = noul(
      `A user is following \`plan\` toward \`goal\`. According to the current \`page\`, is step ${step.number}, "${step.text}", now complete? Field values, selections and the page shown are the evidence; a field the step asks for must actually be filled in.`,
    );
  }

  const { answers } = await askSystemOne({ state, questions });
  const stepCompletion: Record<number, number> = {};
  for (const step of steps.filter((planStep) => !planStep.done)) {
    const answer = answers[`step${step.number}`];
    if (answer?.type === "noul") stepCompletion[step.number] = answer.noul;
  }
  const offTrackAnswer = answers.offTrack;
  return { stepCompletion, offTrack: offTrackAnswer?.type === "noul" ? offTrackAnswer.noul : 0 };
}
