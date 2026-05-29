/**
 * Self-hosted contact enrichment (Apollo-style, no third-party API).
 *
 *   name + company
 *     -> resolve company domain (web search)
 *     -> check the domain can receive mail (DNS MX lookup)
 *     -> generate ranked candidate emails from common patterns
 *     -> attempt SMTP verification (no email sent; falls back gracefully
 *        when outbound port 25 is blocked, which is common)
 *     -> return best email + a confidence label
 *
 * Confidence: "verified" (SMTP confirmed) > "likely" (valid mail domain,
 * best-guess pattern) > "guessed" (no MX) > "unknown" (no domain/name).
 */
const dns = require("dns").promises;
const net = require("net");

const SOCIAL_OR_DIRECTORY = [
  "linkedin.", "facebook.", "twitter.", "x.com", "instagram.", "wikipedia.",
  "glassdoor.", "indeed.", "crunchbase.", "bloomberg.", "gov.uk", "companieshouse",
  "youtube.", "github.", "trustpilot.", "yell.com", "google.", "duckduckgo.",
];

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_e) {
    return "";
  }
}

async function resolveDomain(company, searchFn) {
  const urls = await searchFn(company + " official website", 6).catch(() => []);
  for (const u of urls) {
    const h = hostnameOf(u);
    if (h && !SOCIAL_OR_DIRECTORY.some((s) => h.includes(s))) return h;
  }
  return null;
}

function nameParts(fullName) {
  const s = String(fullName || "").trim();
  let first = "", last = "";
  if (s.includes(",")) {
    // "SURNAME, First Middle"
    const [l, rest] = s.split(",");
    last = l.trim();
    first = (rest || "").trim().split(/\s+/)[0] || "";
  } else {
    const parts = s.split(/\s+/);
    first = parts[0] || "";
    last = parts.length > 1 ? parts[parts.length - 1] : "";
  }
  const clean = (x) => x.toLowerCase().replace(/[^a-z]/g, "");
  return { first: clean(first), last: clean(last) };
}

function candidateEmails(first, last, domain) {
  const out = [];
  if (first && last) {
    out.push(
      first + "." + last, first + last, first[0] + last,
      first + "." + last[0], last + "." + first, first[0] + "." + last
    );
  }
  if (first) out.push(first);
  if (last) out.push(last);
  return [...new Set(out)].map((u) => u + "@" + domain);
}

async function mxHost(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx.length) return null;
    mx.sort((a, b) => a.priority - b.priority);
    return mx[0].exchange;
  } catch (_e) {
    return null;
  }
}

// SMTP probe: connect, EHLO, MAIL FROM, RCPT TO — read the RCPT response code.
// 250-range => mailbox accepted. Never sends an actual message.
function smtpProbe(host, email) {
  return new Promise((resolve) => {
    const result = { connected: false, exists: null };
    let stage = 0;
    let socket;
    const done = () => { try { socket.destroy(); } catch (_e) {} resolve(result); };
    try {
      socket = net.createConnection(25, host);
    } catch (_e) {
      return resolve(result);
    }
    socket.setTimeout(7000, done);
    socket.on("error", done);
    const cmds = [
      "EHLO verify.local\r\n",
      "MAIL FROM:<probe@verify.local>\r\n",
      "RCPT TO:<" + email + ">\r\n",
    ];
    socket.on("data", (data) => {
      const code = parseInt(String(data).slice(0, 3), 10);
      if (stage === 0) { result.connected = true; socket.write(cmds[0]); stage++; }
      else if (stage === 1) { socket.write(cmds[1]); stage++; }
      else if (stage === 2) { socket.write(cmds[2]); stage++; }
      else if (stage === 3) { result.exists = code >= 250 && code < 260; done(); }
    });
  });
}

async function enrichPerson(person, searchFn) {
  const { fullName, company } = person;
  const domain = company ? await resolveDomain(company, searchFn) : null;
  if (!domain) return { email: null, confidence: "unknown", note: "could not resolve company domain" };

  const { first, last } = nameParts(fullName);
  const cands = candidateEmails(first, last, domain);
  if (!cands.length) return { email: null, confidence: "unknown", domain, note: "could not parse name" };

  const mx = await mxHost(domain);
  if (!mx) {
    return { email: cands[0], confidence: "guessed", domain, candidates: cands,
             note: "domain has no MX record (may not receive mail)" };
  }

  // Attempt SMTP verification on the top few candidates.
  let portBlocked = false;
  for (const c of cands.slice(0, 4)) {
    const r = await smtpProbe(mx, c);
    if (!r.connected) { portBlocked = true; break; }
    if (r.exists) return { email: c, confidence: "verified", domain, candidates: cands };
  }
  return {
    email: cands[0],
    confidence: "likely",
    domain,
    candidates: cands,
    note: portBlocked
      ? "SMTP verification unavailable (outbound port 25 blocked); best-guess pattern on a valid mail domain"
      : "mailbox not confirmed; best-guess pattern on a valid mail domain",
  };
}

module.exports = { enrichPerson, candidateEmails, nameParts, resolveDomain, mxHost };
