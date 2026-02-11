const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

/**
 * =========================
 * In-memory stores (demo)
 * =========================
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
 * Menu Text (UPDATED)
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

function sopMenuPrompt() {
  return (
    `Info & SOP GA:\n` +
    `1) Jadwal Shuttle\n` +
    `2) SOP Booking Ruang\n` +
    `3) SOP Pantry\n` +
    `4) SOP Visitor\n` +
    `5) Emergency\n\n` +
    `Balas angka (atau 0 untuk Menu)`
  );
}

/**
 * =========================
 * Session Helpers
 * =========================
 */
function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { mode: "MENU" });
  }
  return sessions.get(userId);
}

function resetSession(userId) {
  sessions.set(userId, { mode: "MENU" });
}

/**
 * =========================
 * Webhook
 * =========================
 */
app.get("/", (req, res) => {
  res.send("Astra GA Virtual Assistant is running");
});

app.post("/whatsapp", (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const numMedia = parseInt(req.body.NumMedia || "0", 10);

  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const session = getSession(from);

  // ===== Global Commands =====
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

  // ===== MENU MODE =====
  if (session.mode === "MENU") {
    if (body === "1") {
      session.mode = "CATEGORY";
      session.ticketDraft = {};
      twiml.message(categoryPrompt());
    } else if (body === "2") {
      session.mode = "CHECK_STATUS";
      twiml.message("Masukkan Ticket ID (contoh: GA-240211-001)");
    } else if (body === "3") {
      session.mode = "SOP";
      twiml.message(sopMenuPrompt());
    } else if (body === "4") {
      twiml.message("Fitur Booking masih dalam pengembangan.\n\nKetik 0 untuk Menu.");
    } else if (body === "9") {
      twiml.message("Silakan hubungi Operator GA di nomor internal.");
    } else {
      twiml.message(menuText());
    }
    return res.type("text/xml").send(twiml.toString());
  }

  // ===== SOP MODE =====
  if (session.mode === "SOP") {
    if (body === "0") {
      resetSession(from);
      twiml.message(menuText());
    } else {
      twiml.message("Template SOP sedang dalam pengembangan.\n\nKetik 0 untuk Menu.");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  // ===== CHECK STATUS =====
  if (session.mode === "CHECK_STATUS") {
    const ticket = tickets.get(body.toUpperCase());
    if (!ticket) {
      twiml.message("Ticket tidak ditemukan.\n\nKetik 0 untuk Menu.");
    } else {
      twiml.message(
        `Status ${ticket.id}: OPEN\nKategori: ${ticket.category}\nLokasi: ${ticket.location}`
      );
    }
    return res.type("text/xml").send(twiml.toString());
  }

  // ===== CATEGORY =====
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

  // ===== LOCATION =====
  if (session.mode === "LOCATION") {
    session.ticketDraft.location = body;
    session.mode = "URGENCY";
    twiml.message(urgencyPrompt());
    return res.type("text/xml").send(twiml.toString());
  }

  // ===== URGENCY =====
  if (session.mode === "URGENCY") {
    if (["1", "2", "3"].includes(body)) {
      session.ticketDraft.urgency = body;
      session.mode = "DESC";
      twiml.message(descPrompt());
    } else {
      twiml.message(urgencyPrompt());
    }
    return res.type("text/xml").send(twiml.toString());
  }

  // ===== DESC =====
  if (session.mode === "DESC") {
    session.ticketDraft.description = body;
    session.mode = "MEDIA";
    twiml.message(mediaPrompt());
    return res.type("text/xml").send(twiml.toString());
  }

  // ===== MEDIA =====
  if (session.mode === "MEDIA") {
    if (numMedia > 0) {
      session.ticketDraft.media = "Media attached";
    }
    const id = makeTicketId();
    const ticket = {
      id,
      ...session.ticketDraft,
      createdAt: nowISO(),
    };
    tickets.set(id, ticket);

    resetSession(from);

    twiml.message(
      `Ticket dibuat: ${id}\nStatus: OPEN\n\nKetik 2 untuk cek status atau 0 untuk menu.`
    );

    return res.type("text/xml").send(twiml.toString());
  }

  twiml.message(menuText());
  return res.type("text/xml").send(twiml.toString());
});

// Railway Port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
