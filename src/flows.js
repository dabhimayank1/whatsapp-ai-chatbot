/**
 * Qualification state machine for WhatsApp — tenant driven.
 *
 * Every question, option and score comes from the tenant's own rows in
 * `tenant_questions`. A gym asks about goals, a restaurant about party size, a
 * developer about budget — same engine, no branching on vertical anywhere.
 *
 * Design notes:
 *
 * * Answers come from button/list taps, so what lands in the database is a
 *   clean option id, never free text to parse.
 * * A customer who asks a real question mid-flow gets a real answer — the
 *   domain classifier and knowledge base still run — and then the bot re-asks
 *   the question it was on. Interrupting the flow must not break it.
 * * The bot goes permanently silent once a human takes over.
 */

import aiEngine from "./aiEngine.js";
import config from "./config.js";
import * as crm from "./crm.js";
import * as db from "./database.js";
import * as leads from "./leads.js";
import * as tenants from "./tenants.js";

const DEFAULT_INTRO =
  "Just a couple of quick questions so I send you the right details.";
const DEFAULT_DONE_HOT =
  "Perfect, thank you! 🙌 One of our team will message you here in a few minutes.";
const DEFAULT_DONE_COLD =
  "Thanks! 🙌 I've noted everything down and our team will follow up shortly. " +
  "Ask me anything in the meantime.";

function tenantOf(lead) {
  return lead.tenant_id ? tenants.get(lead.tenant_id) : null;
}

/** Ask question `index`, queued rather than sent inline. */
function sendStep(lead, steps, index) {
  const step = steps[index];
  const payload = {
    to: lead.wa_id,
    body: step.question,
    options: step.options,
    phone_number_id: lead._phone_number_id || "",
  };
  if (step.qtype === "button" && step.options.length <= 3) {
    db.enqueue("whatsapp", "wa_buttons", payload, lead.id);
  } else {
    payload.button = step.button_label || "Choose";
    db.enqueue("whatsapp", "wa_list", payload, lead.id);
  }
  db.saveMessage(lead.id, "whatsapp", "assistant", step.question);
}

function say(lead, text) {
  db.enqueue("whatsapp", "wa_text",
             { to: lead.wa_id, text, phone_number_id: lead._phone_number_id || "" },
             lead.id);
  db.saveMessage(lead.id, "whatsapp", "assistant", text);
}

/** Match typed text against one question's options, or return null.
 *
 * Deliberately strict, because a wrong match is worse than no match: it records
 * an answer the customer never gave, scores it, and moves the flow on, all
 * invisibly. Falling through to the AI instead just costs one model call.
 *
 * Substring containment was the original approach and it misfired badly — with
 * options yes/maybe/no, `"i don't know"` matched "no" (inside "k-no-w") and
 * `"not now"` matched it twice over, so anyone expressing hesitation was
 * recorded as a firm no. Whole words only, and anything ambiguous is refused.
 */
export function matchOption(step, text) {
  const lowered = String(text || "").toLowerCase().trim();
  if (!lowered) return null;
  const options = step.options || [];

  // 1. The whole message IS an option id or its title. Unambiguous.
  const exact = options.find(
    ([id, title]) =>
      String(id).toLowerCase() === lowered ||
      String(title).toLowerCase() === lowered,
  );
  if (exact) return exact;

  // 2. Otherwise the option must appear as whole words. "3 BHK" has to match
  //    the title "3 BHK", so compare word sequences rather than single tokens.
  const words = lowered.split(/\W+/).filter(Boolean);
  const haystack = ` ${words.join(" ")} `;
  const asWords = (value) =>
    ` ${String(value).toLowerCase().split(/\W+/).filter(Boolean).join(" ")} `;

  const hits = options.filter(([id, title]) => {
    const idWords = asWords(id);
    const titleWords = asWords(title);
    return (idWords.trim() && haystack.includes(idWords)) ||
           (titleWords.trim() && haystack.includes(titleWords));
  });

  // 3. Exactly one option, or we do not guess. "should i buy or rent?" names
  //    two and is a question, not an answer.
  if (hits.length !== 1) {
    if (hits.length > 1) {
      console.log(
        `text reply matched ${hits.length} options (${hits.map((h) => h[0]).join(", ")}) ` +
        "— too ambiguous to answer for them, sending to the model instead",
      );
    }
    return null;
  }
  return hits[0];
}

export function startFlow(lead) {
  const tenant = tenantOf(lead);
  const steps = lead.tenant_id ? tenants.questions(lead.tenant_id) : [];
  if (!steps.length) {
    console.log(`tenant ${lead.tenant_id} has no questions configured`);
    return;
  }
  db.updateLead(lead.id, { flow_active: 1, flow_step: 0 });
  db.advanceStage(lead.id, "QUALIFYING");
  say(lead, tenants.text(tenant, "flow_intro", DEFAULT_INTRO));
  sendStep(lead, steps, 0);
}

function finishFlow(lead) {
  const leadId = lead.id;
  const tenant = tenantOf(lead);
  db.updateLead(leadId, { flow_active: 0, qualified_at: db.now() });
  db.advanceStage(leadId, "QUALIFIED", db.summaryOf(leadId));
  const [score, band] = leads.scoreLead(leadId);

  if (band === "HOT") {
    say(lead, tenants.text(tenant, "flow_done_hot", DEFAULT_DONE_HOT));
    leads.handOff(leadId, `hot lead, score ${score}`);
  } else {
    say(lead, tenants.text(tenant, "flow_done_cold", DEFAULT_DONE_COLD));
    crm.pushLead(leadId);
  }
}

/** A button or list row was tapped. */
export function handleInteractiveReply(lead, optionId, title) {
  const leadId = lead.id;
  db.saveMessage(leadId, "whatsapp", "user", title);

  if (!lead.tenant_id) {
    console.log(`tap outside a tenant for lead ${leadId}`);
    return;
  }

  if (!lead.flow_active) {
    db.updateLead(leadId, { flow_active: 1 });
    lead = db.getLead(leadId);
  }

  const steps = tenants.questions(lead.tenant_id);
  const index = lead.flow_step;
  if (index >= steps.length) return;

  const step = steps[index];
  const points = parseInt(step.score_map[optionId] ?? 0, 10);
  const match = step.options.find(([id]) => id === optionId);
  const label = match ? match[1] : title;
  db.saveAnswer(leadId, step.key, optionId, label, points);
  db.addEvent(leadId, "ANSWERED", `${step.key} = ${optionId} (+${points})`);
  leads.scoreLead(leadId);

  const nxt = index + 1;
  db.updateLead(leadId, { flow_step: nxt });
  const fresh = db.getLead(leadId);
  fresh._phone_number_id = lead._phone_number_id;

  if (nxt < steps.length) {
    sendStep(fresh, steps, nxt);
  } else {
    finishFlow(fresh);
  }
}

/** Free text from the customer.
 *
 * Escalation keywords win. Otherwise the tenant's domain lock decides whether
 * this gets an answer at all, and an active flow is resumed afterwards.
 */
export async function handleText(lead, text) {
  const leadId = lead.id;
  const tenant = tenantOf(lead);
  db.saveMessage(leadId, "whatsapp", "user", text);

  if (lead.bot_paused) return; // a human owns this thread

  const lowered = text.toLowerCase().trim();
  if (config.HUMAN_KEYWORDS.some((kw) => lowered.includes(kw))) {
    say(lead, config.ESCALATION_MESSAGE);
    leads.handOff(leadId, "customer asked for a human");
    return;
  }

  // Typing the answer should work as well as tapping it — plenty of people
  // reply "3 BHK" instead of using the button.
  if (lead.flow_active && lead.tenant_id) {
    const steps = tenants.questions(lead.tenant_id);
    const index = lead.flow_step;
    if (index < steps.length) {
      const match = matchOption(steps[index], text);
      if (match) {
        console.log(`text reply matched step ${index} option: ${match[0]} (${match[1]})`);
        handleInteractiveReply(lead, match[0], match[1]);
        return;
      }
    }
  }

  // A message carrying this lead's own ref code is the prefilled text WE
  // wrote, arriving from our own reel. It is in scope by construction —
  // running it through the classifier risks refusing a lead over our own
  // wording ("6-week program" contains no obvious gym vocabulary).
  const ownRef = Boolean(lead.ref_code) && leads.extractRef(text) === lead.ref_code;
  const isIntro = Boolean(leads.extractRef(text)) || ownRef || /^\s*(hi|hello|hey|interested|info|price|details|start)/i.test(text);
  const label = isIntro ? "IN" : await aiEngine.classify(text, tenant);

  if (label === "OUT") {
    // The refusal and the streak come FIRST, whether or not a flow is running.
    // Skipping them mid-flow disabled the domain lock for most of every
    // conversation: the bot answered nothing, said nothing about being unable
    // to help, and — because the streak never advanced — could never escalate
    // to a human, so a stuck customer just got the same buttons forever.
    const streak = (lead.out_of_scope_streak || 0) + 1;
    db.updateLead(leadId, { out_of_scope_streak: streak });

    if (streak >= config.ESCALATE_AFTER_OUT_OF_SCOPE) {
      say(lead, config.ESCALATION_MESSAGE);
      leads.handOff(leadId, "repeated off-topic messages");
      return;
    }

    say(lead, tenants.outOfScopeMessage(tenant));

    // Then put the flow back in front of them, so an off-topic detour does not
    // leave the qualification stranded with no visible next step.
    if (lead.flow_active && lead.tenant_id) {
      const steps = tenants.questions(lead.tenant_id);
      if (lead.flow_step < steps.length) {
        const fresh = db.getLead(leadId);
        fresh._phone_number_id = lead._phone_number_id;
        sendStep(fresh, steps, lead.flow_step);
      }
    }
    return;
  }

  db.updateLead(leadId, { out_of_scope_streak: 0 });
  const answer = await aiEngine.generateAnswer(leadId, text, tenant);
  say(lead, answer);

  const steps = lead.tenant_id ? tenants.questions(lead.tenant_id) : [];
  if (!steps.length) return;

  const withPnid = (row) => {
    row._phone_number_id = lead._phone_number_id;
    return row;
  };

  // First real message on a fresh lead → start qualifying.
  if (!lead.flow_active && lead.flow_step === 0 &&
      !Object.keys(db.getAnswers(leadId)).length) {
    startFlow(withPnid(db.getLead(leadId)));
    return;
  }

  // Mid-flow question answered — put the flow back on the rails.
  if (lead.flow_active && lead.flow_step < steps.length) {
    sendStep(withPnid(db.getLead(leadId)), steps, lead.flow_step);
  }
}
