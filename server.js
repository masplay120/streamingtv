import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";
import events from "events";
events.EventEmitter.defaultMaxListeners = 1000000;

// ---------------- CONFIGURACIÓN ----------------
const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());

const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

const channelStatus = {};
const PLAYLIST_CACHE = {};
const CHECK_INTERVAL = 5000;

for (const ch in channels) {
  channelStatus[ch] = { live: false };
  PLAYLIST_CACHE[ch] = "#EXTM3U\n";
}

// ---------------- CHEQUEAR SI ESTÁ LIVE ----------------
async function checkLive(channel, url) {
  try {
    const resp = await fetch(url, { headers: { Range: "bytes=0-200" } });
    channelStatus[channel].live = resp.ok;
  } catch {
    channelStatus[channel].live = false;
  }
}

for (const ch in channels) {
  setInterval(() => checkLive(ch, channels[ch].live), CHECK_INTERVAL);
}

// ---------------- CORS ----------------
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Range"
  );
  next();
});

// ---------------- ADMIN PANEL ----------------
app.use("/admin", express.static("admin"));

// Obtener canales
app.get("/api/channels", (req, res) => {
  res.json(channels);
});

// Guardar canales
app.post("/api/channels", (req, res) => {
  channels = req.body;
  fs.writeFileSync(CHANNELS_PATH, JSON.stringify(channels, null, 2));
  res.json({ message: "Canales actualizados correctamente" });
});

// ---------------- PLAYLIST PROXY ----------------
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  const playlistUrl = channelStatus[channel].live ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();

    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      if (line.startsWith("http")) return line;
      return `/proxy/${channel}/${line}`;
    });

    PLAYLIST_CACHE[channel] = text;

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch {
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(PLAYLIST_CACHE[channel]);
  }
});

// ---------------- SEGMENTOS ----------------
for (const channel in channels) {
  app.use(`/proxy/${channel}/`, (req, res, next) => {
    const baseUrl = channelStatus[channel].live
      ? channels[channel].live
      : channels[channel].cloud;

    const urlObj = new URL(baseUrl);
    urlObj.pathname = urlObj.pathname.substring(
      0,
      urlObj.pathname.lastIndexOf("/") + 1
    );
    const baseUrlDir = urlObj.toString();

    createProxyMiddleware({
      target: baseUrlDir,
      changeOrigin: true,
      pathRewrite: { [`^/proxy/${channel}/`]: "" },
      onProxyRes: (proxyRes, req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Origin, X-Requested-With, Content-Type, Accept, Range"
        );
        res.setHeader("Accept-Ranges", "bytes");
      },
    })(req, res, next);
  });
}

// ---------------- ESTADO ----------------
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel])
    return res.status(404).send({ error: "Canal no encontrado" });
  res.json({ live: channelStatus[channel].live });
});

// ---------------- INICIO ----------------
app.listen(PORT, () =>
  console.log(`✅ Proxy TV activo en http://localhost:${PORT}`)
);
