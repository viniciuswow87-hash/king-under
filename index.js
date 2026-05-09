const axios = require("axios");

// ══════════════════════════════════════
//  KING UNDER — Agente 24h
//  Detecta jogos com ≥2 gols até 35'
//  com tendência under → alerta Telegram
// ══════════════════════════════════════

const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  CHAT_ID:        process.env.CHAT_ID,
  API_KEY:        process.env.API_KEY,
  MIN_GOALS:      parseInt(process.env.MIN_GOALS  || "2"),
  MAX_MINUTE:     parseInt(process.env.MAX_MINUTE || "35"),
  MAX_ODDS:       parseFloat(process.env.MAX_ODDS || "1.65"),
  INTERVAL_SEC:   parseInt(process.env.INTERVAL_SEC || "120"),
};

const alertedGames = new Set();
let scanCount  = 0;
let alertCount = 0;

// ── log com horário ──
function log(msg) {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  console.log(`[${now}] ${msg}`);
}

// ── busca jogos ao vivo ──
async function fetchLiveGames() {
  try {
    const res = await axios.get("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: { "x-apisports-key": CONFIG.API_KEY },
      timeout: 10000,
    });

    if (!res.data || !res.data.response) return [];
    return res.data.response.map((f) => ({
      id:        f.fixture.id.toString(),
      home:      f.teams.home.name,
      away:      f.teams.away.name,
      league:    f.league.name,
      country:   f.league.country,
      minute:    f.fixture.status.elapsed || 0,
      homeGoals: f.goals.home || 0,
      awayGoals: f.goals.away || 0,
    }));
  } catch (err) {
    log(`❌ Erro ao buscar jogos: ${err.message}`);
    return [];
  }
}

// ── calcula under score ──
function calcUnderScore(game, total) {
  let score = 0;
  if (total === 2) score += 35;
  else if (total === 3) score += 25;
  else score += 15;

  if (game.minute <= 20) score += 22;
  else if (game.minute <= 28) score += 15;
  else score += 8;

  // Bonus por poucos gols relativos ao tempo
  const rate = total / game.minute; // gols por minuto
  if (rate <= 0.07) score += 20;
  else if (rate <= 0.10) score += 12;
  else score += 5;

  return Math.min(99, Math.round(score));
}

// ── monta mensagem Telegram ──
function buildMessage(game, total, underScore) {
  const fire  = underScore >= 80 ? "🔥🔥" : underScore >= 65 ? "⚡" : "📊";
  const stars = underScore >= 80 ? "★★★" : underScore >= 65 ? "★★☆" : "★☆☆";
  const mkt   = total === 2 ? "Under 3.5 ou Under 4.5"
              : total === 3 ? "Under 4.5"
              : "Under 5.5";

  return `👑 <b>KING UNDER — ALERTA</b> ${fire}

⚽ <b>${game.home}</b> <code>${game.homeGoals} × ${game.awayGoals}</code> <b>${game.away}</b>
🏆 <i>${game.league} · ${game.country}</i>

⏱ <b>Minuto:</b> ${game.minute}'
🎯 <b>Gols no 1º Tempo:</b> ${total}
🤖 <b>Under Score:</b> ${underScore}% ${stars}

💡 <i>Mercado sugerido: ${mkt}</i>

⚠️ <i>King Under Agent · Aposte com responsabilidade.</i>`;
}

// ── envia mensagem Telegram ──
async function sendTelegram(text) {
  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`;
    const res = await axios.post(url, {
      chat_id:    CONFIG.CHAT_ID,
      text,
      parse_mode: "HTML",
    }, { timeout: 8000 });
    return res.data.ok === true;
  } catch (err) {
    log(`❌ Erro Telegram: ${err.message}`);
    return false;
  }
}

// ── varredura principal ──
async function runScan() {
  scanCount++;
  log(`🔍 Varredura #${scanCount} iniciada...`);

  const games = await fetchLiveGames();
  log(`📋 ${games.length} jogos ao vivo encontrados`);

  for (const game of games) {
    if (game.minute < 1 || game.minute > CONFIG.MAX_MINUTE) continue;

    const total = game.homeGoals + game.awayGoals;
    if (total < CONFIG.MIN_GOALS) continue;

    const key = `${game.id}-${total}`;
    if (alertedGames.has(key)) continue;

    alertedGames.add(key);
    alertCount++;

    const underScore = calcUnderScore(game, total);
    log(`🚨 ALERTA #${alertCount}: ${game.home} ${game.homeGoals}x${game.awayGoals} ${game.away} — ${game.minute}' — Score: ${underScore}%`);

    const msg  = buildMessage(game, total, underScore);
    const sent = await sendTelegram(msg);
    log(sent ? `✈️  Telegram enviado!` : `⚠ Falha no envio Telegram`);
  }

  log(`✅ Varredura #${scanCount} concluída. Total alertas: ${alertCount}`);
}

// ── startup ──
async function start() {
  log("👑 KING UNDER AGENT INICIADO");
  log(`📋 Critério: ≥${CONFIG.MIN_GOALS} gols até o ${CONFIG.MAX_MINUTE}'`);
  log(`⏱ Intervalo: ${CONFIG.INTERVAL_SEC}s`);

  // Mensagem de início no Telegram
  await sendTelegram(`👑 <b>King Under Agent iniciado!</b>\n\n✅ Monitorando jogos ao vivo\n🎯 Critério: ≥${CONFIG.MIN_GOALS} gols até o ${CONFIG.MAX_MINUTE}'\n⏱ Varredura a cada ${CONFIG.INTERVAL_SEC}s`);

  // Primeira varredura imediata
  await runScan();

  // Loop contínuo
  setInterval(runScan, CONFIG.INTERVAL_SEC * 1000);
}

// ── servidor HTTP simples (Render exige porta aberta) ──
const http = require("http");
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`👑 King Under ativo | Varreduras: ${scanCount} | Alertas: ${alertCount}`);
}).listen(process.env.PORT || 3000, () => {
  log(`🌐 Servidor HTTP na porta ${process.env.PORT || 3000}`);
  start();
});
