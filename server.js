import fs from "fs";
import path from "path";
import express from "express";
import fetch from "node-fetch";
import { createProxyMiddleware } from "http-proxy-middleware";
import events from "events";
events.EventEmitter.defaultMaxListeners = 1000000;

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());

const CHANNELS_PATH = path.join(process.cwd(), "channels.json");
let channels = JSON.parse(fs.readFileSync(CHANNELS_PATH, "utf8"));

const channelStatus = {};
const PLAYLIST_CACHE = {};
const CHECK_INTERVAL = 8000; // cada 8 segundos

// Inicializar
for (const ch in channels) {
  channelStatus[ch] = { live: false, lastChecked: 0 };
  PLAYLIST_CACHE[ch] = "#EXTM3U\n";
}

// ------------------ Función para probar si el LIVE está disponible ------------------
async function checkLive(channel, url) {
  try {
    const response = await fetch(url, {
      headers: { "Range": "bytes=0-500" },
      timeout: 5000
    });
    const text = await response.text();
    // Detectar que la respuesta tenga al menos un segmento .ts válido
    channelStatus[channel].live = response.ok && text.includes(".ts");
  } catch {
    channelStatus[channel].live = false;
  }
}

// Ejecutar chequeos continuos
for (const ch in channels) {
  setInterval(async () => {
    const prev = channelStatus[ch].live;
    await checkLive(ch, channels[ch].live);

    if (prev !== channelStatus[ch].live) {
      console.log(
        `🔁 Canal ${ch} cambió a ${channelStatus[ch].live ? "LIVE ✅" : "CLOUD ☁️"}`
      );
    }
  }, CHECK_INTERVAL);
}

// ------------------ CORS ------------------
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Range"
  );
  next();
});

// ------------------ PANEL ADMIN ------------------
app.use("/admin", express.static("admin"));

app.get("/api/channels", (req, res) => res.json(channels));

app.post("/api/channels", (req, res) => {
  channels = req.body;
  fs.writeFileSync(CHANNELS_PATH, JSON.stringify(channels, null, 2));
  res.json({ message: "Canales actualizados correctamente" });
});

// ------------------ PLAYLIST PROXY ------------------
app.get("/proxy/:channel/playlist.m3u8", async (req, res) => {
  const { channel } = req.params;
  const config = channels[channel];
  if (!config) return res.status(404).send("Canal no encontrado");

  // Seleccionar origen dinámicamente
  const isLive = channelStatus[channel].live;
  const playlistUrl = isLive ? config.live : config.cloud;

  try {
    const response = await fetch(playlistUrl);
    let text = await response.text();

    // Reescribir las rutas .ts para pasarlas por el proxy
    text = text.replace(/^(?!#)(.*\.ts.*)$/gm, (line) => {
      if (line.startsWith("http")) return line;
      return `/proxy/${channel}/${line}`;
    });

    PLAYLIST_CACHE[channel] = text;

    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(text);
  } catch (err) {
    // Si hay error, enviar última playlist válida
    console.warn(`⚠️ Error en ${channel}, usando caché`);
    res.header("Content-Type", "application/vnd.apple.mpegurl");
    res.send(PLAYLIST_CACHE[channel]);
  }
});

// ------------------ SEGMENTOS TS ------------------
for (const channel in channels) {
  app.use(`/proxy/${channel}/`, (req, res, next) => {
    const isLive = channelStatus[channel].live;
    const baseUrl = isLive ? channels[channel].live : channels[channel].cloud;

    const urlObj = new URL(baseUrl);
    urlObj.pathname = urlObj.pathname.substring(
      0,
      urlObj.pathname.lastIndexOf("/") + 1
    );
    const baseDir = urlObj.toString();

    createProxyMiddleware({
      target: baseDir,
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

// ------------------ ESTADO ------------------
app.get("/status/:channel", (req, res) => {
  const { channel } = req.params;
  if (!channels[channel])
    return res.status(404).json({ error: "Canal no encontrado" });
  res.json({ live: channelStatus[channel].live });
});

// ------------------ INICIAR SERVIDOR ------------------
app.listen(PORT, () => {
  console.log(`✅ Proxy TV funcionando en http://localhost:${PORT}`);
});
