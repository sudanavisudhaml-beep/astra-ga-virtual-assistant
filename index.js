const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();

// Twilio kirim data sebagai form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// Health check (tes server hidup)
app.get("/", (req, res) => {
  res.status(200).send("Astra GA Virtual Assistant is running");
});

// Endpoint untuk WhatsApp
app.post("/whatsapp", (req, res) => {
  const incomingMsg = (req.body.Body || "").trim();

  const MessagingResponse = twilio.twiml.MessagingResponse;
  const response = new MessagingResponse();

  response.message(
    `Halo 👋\nIni Astra GA Virtual Assistant.\nPesan kamu: "${incomingMsg}"`
  );

  res.type("text/xml");
  res.send(response.toString());
});

// PENTING untuk Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
