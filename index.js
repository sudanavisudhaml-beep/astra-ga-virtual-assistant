const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

/**
 * =========================
 * ENV
 * =========================
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // bisa kamu ganti di Railway Variables
const GPT_TIMEOUT_MS = parseInt(process.env.GPT_TIMEOUT_MS || "8000", 10);

/**
 * =========================
 * In-memory stores (demo)
 * =========================
 * NOTE: Ini hanya sementara. Nanti tiket bisa kita simpan ke DB/Sheet/Jira.
 */
const sessions = new Map();
const tickets = new Map();
let dailyCounter = { dateKey: "", seq: 0 };

function nowISO() {
  return new Date().toISOString();
}

function makeTicketId() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const dateKey = `${yy}${mm}${dd}`;

  if (dailyCounter.dateKey !== dateKey) {
    dailyCounter.dateKey = dateKey;
    dailyCounter.seq = 0;
  }

  dailyCounter.seq += 1;
  const seqStr = String(dailyCounter.seq).padStart(3, "0");
  return `GA-${dateKey}-${seqStr}`;
}

/**
 * =========================
 * Menu Text (99 hidden)
 * =========================
 */
function menuText() {
  return (
    `Halo 👋 Insan Astra Saya GA Virtual Assistant siap membantu kamu\n\n` +
    `Silakan pilih layanan:\n` +
    `1) Buat Komplain / Ticket\n` +
    `2) Cek Status Ticket\n` +
    `3) Info & SOP GA\n` +
    `4) Booking / Permintaan Layanan\n` +
    `9) Hubungi Operator\n\n` +
    `Balas angka ya.\n` +
    `(Ketik 0 untuk kembali ke menu kapan saja)`
  );
}

/**
 * =========================
 * Ticket Flow Prompts
 * =========================
 */
const categoryMap = {
  "1": "AC / HVAC",
  "2": "Listrik / Lampu",
  "3": "Toilet / Plumbing",
  "4": "Housekeeping",
  "5": "Lift / Eskalator",
  "6": "Keamanan / Safety",
  "7": "IT / Network",
  "8": "Lainnya",
};

function categoryPrompt() {
  return (
    `Pilih kategori komplain:\n` +
    `1) AC / HVAC\n` +
    `2) Listrik / Lampu\n` +
    `3) Toilet / Plumbing\n` +
    `4) Housekeeping\n` +
    `5) Lift / Eskalator\n` +
    `6) Keamanan / Safety\n` +
    `7) IT / Network\n` +
    `8) Lainnya\n\n` +
    `Balas angka (atau 0 untuk Menu)`
  );
}

function locationPrompt() {
  return (
    `Lokasi kejadian?\n` +
    `Contoh: Menara Astra Lt 32 Ruang Meeting A\n` +
    `(atau 0 untuk Menu)`
  );
}

function urgencyPrompt() {
  return (
    `Tingkat urgensi:\n` +
    `1) Darurat\n` +
    `2) Tinggi\n` +
    `3) Normal\n\n` +
    `Balas 1/2/3 (atau 0 untuk Menu)`
  );
}

function descPrompt() {
  return `Jelaskan keluhannya singkat ya.\n(atau 0 untuk Menu)`;
}

function mediaPrompt() {
  return `Jika ada foto/video kirim sekarang.\nJika tidak ada balas: SKIP`;
}

/**
 * =========================
 * SOP
 * =========================
 */
function sopMenuPrompt() {
  return (
    `Info & SOP GA:\n` +
    `1) Jadwal Shuttle\n` +
    `2) SOP Booking Ruang\n` +
    `3) SOP Pantry\n` +
    `4) SOP Visitor\n` +
    `5) Emergency\n\n` +
    `Ketik angka untuk lihat template singkat,\n` +
    `atau langsung tanya dengan bahasa biasa.\n` +
    `(Ketik 0 untuk Menu)`
  );
}

function sopTemplateByChoice(choice) {
  switch (choice) {
    case "1":
      return (
        `🚌 *Jadwal Shuttle (template)*\n` +
        `- Titik jemput: (isi)\n` +
        `- Jam operasional: (isi)\n` +
        `- Aturan: datang 5 menit lebih awal\n\n` +
        `Kamu bisa tanya detail: "Shuttle terakhir jam berapa?"`
      );
    case "2":
      return (
        `🏢 *SOP Booking Ruang (template)*\n` +
        `1) Tentukan tanggal/jam\n` +
        `2) Tentukan kapasitas\n` +
        `3) Ajukan booking\n` +
        `4) Konfirmasi\n\n` +
        `Tanya aja: "Cara booking ruang 20 orang?"`
      );
    case "3":
      return (
        `☕ *SOP Pantry (template)*\n` +
        `- Jam layanan\n` +
        `- Aturan kebersihan\n` +
        `- Pelaporan jika ada kendala\n\n` +
        `Tanya aja: "Kalau dispenser rusak lapor ke siapa?"`
      );
    case "4":
      return (
        `🧾 *SOP Visitor (template)*\n` +
        `1) Registrasi tamu\n` +
        `2) ID/akses\n` +
        `3) Pendampingan\n` +
        `4) Check-out\n\n` +
        `Tanya aja: "Proses visitor untuk vendor gimana?"`
      );
    case "5":
      return (
        `🚨 *Emergency (template)*\n` +
        `- Tetap tenang\n` +
        `- Ikuti jalur evakuasi\n` +
        `- Hubungi Security/GA\n\n` +
        `Tanya aja: "Kalau alarm bunyi saya harus apa?"`
      );
    default:
      return null;
  }
}

/**
 * =========================
 * Session Helpers
 * =========================
 */
function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { mode: "MENU" });
  return sessions.get(userId);
}

function resetSession(userId) {
  sessions.set(userId, { mode: "MENU" });
}

/**
 * =========================
 * GPT Helpers (with timeout)
 * =========================
 */
function sanitizeUserText(text) {
  // basic trim + max length
  const t = (text || "").trim();
  if (t.length > 1500) return t.slice(0, 1500) + "…";
  return t;
}

async function callGPT(messages) {
  if (!OPENAI_API_KEY) {
    return { ok: false, text: "" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GPT_TIMEOUT_MS);

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        max_tokens: 350,
        messages,
      }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return { ok: false, text: "" };
    }

    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: "" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GPT: SOP Q&A
 */
async function gptAnswerSOP(question) {
  const q = sanitizeUserText(question);

  const messages = [
    {
      role: "system",
      content:
        "Kamu adalah Astra GA Virtual Assistant. Jawab ringkas, profesional, dan praktis. " +
        "Jika pertanyaan butuh data spesifik kantor (jadwal aktual, nomor internal, SOP internal) yang tidak kamu miliki, " +
        "jawab dengan template + langkah umum, lalu sarankan hubungi operator GA. " +
        "Jangan minta/menyebut data sensitif (NIK, nomor HP pribadi, detail keamanan). " +
        "Akhiri jawaban dengan satu pertanyaan klarifikasi jika perlu.",
    },
    { role: "user", content: q },
  ];

  const out = await callGPT(messages);
  return out.ok ? out.text : "";
}

/**
 * GPT: Rapihkan komplain
 * Output format: JSON (title, cleaned_description, suggested_category, suggested_urgency)
 */
async function gptTidyComplaint({ category, urgency, location, description }) {
  const desc = sanitizeUserText(description);

  const messages = [
    {
      role: "system",
      content:
        "Kamu adalah asisten untuk merapihkan komplain fasilitas GA. " +
        "Kembalikan output dalam JSON valid tanpa tambahan teks. " +
        "Field wajib: title, cleaned_description, suggested_category, suggested_urgency. " +
        "suggested_category pilih salah satu dari: AC / HVAC, Listrik / Lampu, Toilet / Plumbing, Housekeeping, Lift / Eskalator, Keamanan / Safety, IT / Network, Lainnya. " +
        "suggested_urgency pilih salah satu: Darurat, Tinggi, Normal. " +
        "cleaned_description ringkas 2-4 kalimat, jelas, tanpa data sensitif.",
    },
    {
      role: "user",
      content:
        `Data:\n` +
        `category_user: ${category}\n` +
        `urgency_user: ${urgency}\n` +
        `location: ${location}\n` +
        `description: ${desc}\n\n` +
        `Tolong rapihkan menjadi JSON.`,
    },
  ];

  const out = await callGPT(messages);
  if (!out.ok) return null;

  try {
    // try parse json
    const jsonText = out.text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

/**
 * GPT: Fallback ketika input di luar menu
 */
async function gptFallbackAnswer(userText) {
  const q = sanitizeUserText(userText);

  const messages = [
    {
      role: "system",
      content:
        "Kamu adalah Astra GA Virtual Assistant. User mengirim pesan yang tidak cocok dengan menu. " +
        "Tugasmu: (1) jawab singkat jika bisa (umum), (2) arahkan user kembali ke menu dengan jelas. " +
        "Jika itu komplain fasilitas, sarankan pilih 1 untuk buat ticket. " +
        "Jika itu SOP, sarankan pilih 3. " +
        "Jangan halu data internal yang tidak kamu tahu.",
    },
    { role: "user", content: q },
  ];

  const out = await callGPT(messages);
  return out.ok ? out.text : "";
}

/**
 * =========================
 * Routes
 * =========================
 */
app.get("/", (req, res) => {
  res.status(200).send("Astra GA Virtual Assistant is running");
});

app.post("/whatsapp", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const numMedia = parseInt(req.body.NumMedia || "0", 10);

  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const session = getSession(from);

  /**
   * =========================
   * Global Commands
   * =========================
   */
  if (body === "99") {
    resetSession(from);
    twiml.message("Session di-reset.\n\n" + menuText());
    return res.type("text/xml").send(twiml.toString());
  }

  if (body === "0") {
    resetSession(from);
    twiml.message(menuText());
    return res.type("text/xml").send(twiml.toString());
  }

  if (body.toUpperCase() === "CANCEL") {
    resetSession(from);
    twiml.message("Proses dibatalkan.\n\n" + menuText());
    return res.type("text/xml").send(twiml.toString());
  }

  /**
   * =========================
   * MENU MODE
   * =========================
   */
  if (session.mode === "MENU") {
    if (body === "1") {
      session.mode = "CATEGORY";
      session.ticketDraft = {};
      twiml.message(categoryPrompt());
      return res.type("text/xml").send(twiml.toString());
    }

    if (body === "2") {
      session.mode = "CHECK_STATUS";
      twiml.message("Masukkan Ticket ID (contoh: GA-240211-001)");
      return res.type("text/xml").send(twiml.toString());
    }

    if (body === "3") {
      session.mode = "SOP";
      twiml.message(sopMenuPrompt());
      return res.type("text/xml").send(twiml.toString());
    }

    if (body === "4") {
      twiml.message("Fitur Booking masih dalam pengembangan.\n\nKetik 0 untuk Menu.");
      return res.type("text/xml").send(twiml.toString());
    }

    if (body === "9") {
      twiml.message("Silakan hubungi Operator GA.\n\nKetik 0 untuk Menu.");
      return res.type("text/xml").send(twiml.toString());
    }

    // Fallback GPT (input di luar menu)
    const fb = await gptFallbackAnswer(body);
    if (fb) {
      twiml.message(`${fb}\n\n—\n${menuText()}`);
    } else {
      twiml.message(menuText());
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /**
   * =========================
   * SOP MODE (GPT + template)
   * =========================
   */
  if (session.mode === "SOP") {
    // Jika pilih angka 1-5, kasih template singkat
    const templ = sopTemplateByChoice(body);
    if (templ) {
      twiml.message(`${templ}\n\nKetik 0 untuk Menu, atau tanya lanjut di sini.`);
      return res.type("text/xml").send(twiml.toString());
    }

    // Selain itu: dianggap pertanyaan bebas → GPT
    const ans = await gptAnswerSOP(body);
    if (ans) {
      twiml.message(`${ans}\n\nKetik 0 untuk Menu.`);
    } else {
      twiml.message("Maaf, sistem SOP sedang sibuk. Coba lagi atau ketik 0 untuk Menu.");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /**
   * =========================
   * CHECK STATUS
   * =========================
   */
  if (session.mode === "CHECK_STATUS") {
    const ticket = tickets.get(body.toUpperCase());
    if (!ticket) {
      twiml.message("Ticket tidak ditemukan.\n\nKetik 0 untuk Menu.");
    } else {
      twiml.message(
        `Status ${ticket.id}: OPEN\nKategori: ${ticket.category}\nLokasi: ${ticket.location}\nJudul: ${ticket.title || "-"}`
      );
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /**
   * =========================
   * CATEGORY
   * =========================
   */
  if (session.mode === "CATEGORY") {
    if (categoryMap[body]) {
      session.ticketDraft.category = categoryMap[body];
      session.mode = "LOCATION";
      twiml.message(locationPrompt());
    } else {
      twiml.message(categoryPrompt());
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /**
   * =========================
   * LOCATION
   * =========================
   */
  if (session.mode === "LOCATION") {
    session.ticketDraft.location = body;
    session.mode = "URGENCY";
    twiml.message(urgencyPrompt());
    return res.type("text/xml").send(twiml.toString());
  }

  /**
   * =========================
   * URGENCY
   * =========================
   */
  if (session.mode === "URGENCY") {
    if (["1", "2", "3"].includes(body)) {
      session.ticketDraft.urgency = body; // 1/2/3
      session.mode = "DESC";
      twiml.message(descPrompt());
    } else {
      twiml.message(urgencyPrompt());
    }
    return res.type("text/xml").send(twiml.toString());
  }

  /**
   * =========================
   * DESC (Auto rapihkan via GPT)
   * =========================
   */
  if (session.mode === "DESC") {
    session.ticketDraft.description_raw = body;

    // map urgency user → text
    const urgencyText = bodyToUrgencyText(session.ticketDraft.urgency);

    // Call GPT to tidy complaint (optional)
    const tidy = await gptTidyComplaint({
      category: session.ticketDraft.category || "Lainnya",
      urgency: urgencyText,
      location: session.ticketDraft.location || "-",
      description: body,
    });

    if (tidy) {
      session.ticketDraft.title = tidy.title || "";
      session.ticketDraft.description = tidy.cleaned_description || body;
      session.ticketDraft.suggested_category = tidy.suggested_category || "";
      session.ticketDraft.suggested_urgency = tidy.suggested_urgency || "";
    } else {
      session.ticketDraft.title = "";
      session.ticketDraft.description = body;
    }

    session.mode = "MEDIA";
    twiml.message(
      `OK. Ringkasan komplain:\n` +
        `${session.ticketDraft.title ? `- Judul: ${session.ticketDraft.title}\n` : ""}` +
        `- Kategori: ${session.ticketDraft.category}\n` +
        `- Lokasi: ${session.ticketDraft.location}\n\n` +
        `Jika ada foto/video kirim sekarang.\nJika tidak ada balas: SKIP`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  /**
   * =========================
   * MEDIA → Create Ticket
   * =========================
   */
  if (session.mode === "MEDIA") {
    if (numMedia > 0) {
      session.ticketDraft.media = "Media attached";
    }

    const id = makeTicketId();

    const ticket = {
      id,
      category: session.ticketDraft.category,
      location: session.ticketDraft.location,
      urgency: bodyToUrgencyText(session.ticketDraft.urgency),
      title: session.ticketDraft.title || "",
      description: session.ticketDraft.description || session.ticketDraft.description_raw || "",
      suggested_category: session.ticketDraft.suggested_category || "",
      suggested_urgency: session.ticketDraft.suggested_urgency || "",
      createdAt: nowISO(),
    };

    tickets.set(id, ticket);
    resetSession(from);

    let extra = "";
    if (ticket.suggested_category && ticket.suggested_category !== ticket.category) {
      extra += `\nCatatan: AI menyarankan kategori "${ticket.suggested_category}".`;
    }
    if (ticket.suggested_urgency && ticket.suggested_urgency !== ticket.urgency) {
      extra += `\nCatatan: AI menyarankan urgensi "${ticket.suggested_urgency}".`;
    }

    twiml.message(
      `✅ Ticket dibuat: ${id}\n` +
        `Status: OPEN\n` +
        `${ticket.title ? `Judul: ${ticket.title}\n` : ""}` +
        `Kategori: ${ticket.category}\n` +
        `Lokasi: ${ticket.location}\n` +
        `Urgensi: ${ticket.urgency}\n` +
        `${extra}\n\n` +
        `Ketik 2 untuk cek status atau 0 untuk menu.`
    );

    return res.type("text/xml").send(twiml.toString());
  }

  // Default fallback
  twiml.message(menuText());
  return res.type("text/xml").send(twiml.toString());
});

/**
 * helpers
 */
function bodyToUrgencyText(u) {
  if (u === "1") return "Darurat";
  if (u === "2") return "Tinggi";
  return "Normal";
}

// Railway Port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));