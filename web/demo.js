// Wires Cursor Agent into the Acme Cloud demo site: the site's own context
// (used by Pitch and Explain) and two site actions with typed parameters.

function showDemoToast(message) {
  const toastElement = document.createElement("div");
  toastElement.className = "toast";
  toastElement.textContent = message;
  document.body.appendChild(toastElement);
  setTimeout(() => toastElement.remove(), 3500);
}

CursorAgent.init({
  endpoint: "", // same origin: the Worker serves this demo
  label: "Acme Cloud demo",
  siteContext: [
    "Acme Cloud is a hosting platform for web apps and APIs. Push code from GitHub and it builds and deploys automatically, with preview links for every pull request.",
    "Plans: Free ($0, 1 project, community support). Pro ($20 per month, unlimited projects, custom domains, email support). Team ($50 per month per 5 seats, everything in Pro plus SSO, audit logs and a 99.9% uptime SLA).",
    "Every paid plan has a 14-day free trial and no card is needed to start. Customers include Northwind and Lumen Labs.",
    "Best next steps for visitors: Start free on the sign-up page, or book a demo for teams.",
  ].join(" "),
  actions: [
    {
      name: "subscribe_newsletter",
      description: "Subscribe an email address to the Acme Cloud newsletter.",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string", description: "The subscriber's email address" },
          frequency: { type: "string", enum: ["weekly", "monthly"] },
        },
        required: ["email", "frequency"],
      },
      run: async ({ email, frequency }) => {
        showDemoToast(`Subscribed ${email} (${frequency})`);
        return { subscribed: true, email, frequency };
      },
    },
    {
      name: "book_demo",
      description: "Request a sales demo for a team.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          team_size: { type: "integer", description: "Number of people on the team" },
        },
        required: ["name", "email", "team_size"],
      },
      run: async ({ name, email, team_size }) => {
        showDemoToast(`Demo requested for ${name}'s team of ${team_size}`);
        return { booked: true, confirmation_sent_to: email };
      },
    },
  ],
});

document.querySelector("[data-open-agent]")?.addEventListener("click", () => CursorAgent.open());
