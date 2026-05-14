const axios = require("axios");
const http  = require("http");

// ══════════════════════════════════════════════
//  KING UNDER — Agente 24h v3.0
//  Fonte: Football-Data.org
//  Filtros avançados ativos
// ══════════════════════════════════════════════

const CONFIG = {
  TELEGRAM_TOKEN:      process.env.TELEGRAM_TOKEN,
  CHAT_ID:             process.env.CHAT_ID,
  API_KEY:             process.env.API_KEY,
  MIN_GOALS:           parseInt(process.env.MIN_GOALS           || "2"),
  MAX_MINUTE:          parseInt(process.env.MAX_MINUTE          || "35"),
  MIN_MINUTE:          parseInt(process.env.MIN_MINUTE          || "10"),
  MAX_SCORE_DIFF:      parseInt(process.env.MAX_SCORE_DIFF      || "1"),
  MIN_UNDER_SCORE:     parseInt(process.env.MIN_UNDER_SCORE     || "65"),
  MAX_ALERTS_PER_SCAN: parseInt(process.env.MAX_ALERTS_PER_SCAN || "3"),
  INTERVAL_SEC:        parseInt(process.env.INTERVAL_SEC        || "60"),
};

// IDs das competições no Football-Data.org
// PL=Premier League, PD=La Liga, BL1=Bundesliga
// SA=Serie A, FL1=Ligue 1, CL=Champions League
// BSB=Brasileirão, PPL=Primeira Liga, DED=Eredivisie
const COMPETITIONS = [
  "PL","PD","BL1","SA","FL1","CL","EC",
  "PPL","DED","BSB","CLI","WC","EL"
];

const alertedGames   = new Set();
const standingsCache = {};
let scanCount  = 0;
let alertCount = 0;

function log(msg) {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  console.log(`[${now}] ${msg}`);
}

// ── busca standings Football-Data ──
async function fetchStandings(competitionCode) {
  if (standingsCache[competitionCode]) return standingsCache[competitionCode];
  try {
    const res = await axios.get(
      `https://api.football-data.org/v4/competitions/${competitionCode}/standings`,
      { headers: { "X-Auth-Token": CONFIG.API_KEY }, timeout: 8000 }
    );
    const table = res.data?.standings?.[0]?.table || [];
    standingsCache[competitionCode] = table;
    setTimeout(() => delete standingsCache[competitionCode], 60 * 60 * 1000);
    return table;
  } catch {
    return [];
  }
}

// ── verifica meio de tabela ──
async function isMidTable(teamId, competitionCode) {
  const table = await fetchStandings(competitionCode);
  if (!table.length) return false;
  const total = table.length;
  const entry = table.find(t => t.team.id === teamId);
  if (!entry) return false;
  const pos        = entry.position;
  const topZone    = 6;
  const bottomZone = total - 5;
  return pos > topZone && pos < bottomZone;
}

// ── busca jogos ao vivo de uma competição ──
async function fetchLiveByCompetition(code) {
  try {
    const res = await axios.get(
      `https://api.football-data.org/v4/competitions/${code}/matches?status=LIVE`,
      { headers: { "X-Auth-Token": CONFIG.API_KEY }, timeout: 10000 }
    );
    return res.data?.matches || [];
  } catch {
    return [];
  }
}

// ── busca todos os jogos ao vivo ──
async function fetchAllLiveGames() {
  try {
    // Endpoint geral de jogos ao vivo
    const res = await axios.get(
      "https://api.football-data.org/v4/matches?status=LIVE",
      { headers: { "X-Auth-Token": CONFIG.API_KEY }, timeout: 12000 }
    );

    const matches = res.data?.matches || [];

    return matches.map(m => ({
      id:              m.id.toString(),
      home:            m.homeTeam.name,
      homeId:          m.homeTeam.id,
      away:            m.awayTeam.name,
      awayId:          m.awayTeam.id,
      league:          m.competition?.name || "Desconhecida",
      competitionCode: m.competition?.code || "",
      country:         m.area?.name || "",
      minute:          m.minute || extractMinute(m.lastUpdated),
      homeGoals:       m.score?.fullTime?.home ?? m.score?.halfTime?.home ?? 0,
      awayGoals:       m.score?.fullTime?.away ?? m.score?.halfTime?.away ?? 0,
    }));
  } catch (err) {
    log(`❌ Erro ao buscar jogos: ${err.message}`);
    return [];
  }
}

// ── extrai minuto aproximado do timestamp ──
function extractMinute(lastUpdated) {
  if (!lastUpdated) return 0;
  // fallback: retorna 0 se não conseguir
  return 0;
}

// ── calcula under score ──
function calcUnderScore(game, total) {
  let score = 0;

  if (total === 2) score += 35;
  else if (total === 3) score += 22;
  else score += 12;

  if (game.minute <= 15) score += 22;
  else if (game.minute <= 25) score += 16;
  else score += 8;

  const rate = game.minute > 0 ? total / game.minute : 0.15;
  if (rate <= 0.07) score += 20;
  else if (rate <= 0.10) score += 12;
  else score += 4;

  const diff = Math.abs(game.homeGoals - game.awayGoals);
  if (diff === 0) score += 10;
  else if (diff === 1) score += 5;

  return Math.min(99, Math.round(score));
}

// ── monta mensagem Telegram ──
function buildMessage(game, total, underScore) {
  const fire  = underScore >= 85 ? "🔥🔥" : underScore >= 70 ? "⚡" : "📊";
  const stars = underScore >= 85 ? "★★★" : underScore >= 70 ? "★★☆" : "★☆☆";
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

⚠️ <i>King Under v3 · Aposte com responsabilidade.</i>`;
}

// ── envia Telegram ──
async function sendTelegram(text) {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: CONFIG.CHAT_ID, text, parse_mode: "HTML" },
      { timeout: 8000 }
    );
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

  const games = await fetchAllLiveGames();
  log(`📋 ${games.length} jogos ao vivo encontrados`);

  let alertsThisScan = 0;

  for (const game of games) {
    if (alertsThisScan >= CONFIG.MAX_ALERTS_PER_SCAN) {
      log(`⚠ Limite de ${CONFIG.MAX_ALERTS_PER_SCAN} alertas atingido`);
      break;
    }

    // FILTRO 1: minuto
    if (game.minute < CONFIG.MIN_MINUTE || game.minute > CONFIG.MAX_MINUTE) continue;

    // FILTRO 2: gols mínimos
    const total = game.homeGoals + game.awayGoals;
    if (total < CONFIG.MIN_GOALS) continue;

    // FILTRO 3: diferença no placar
    const diff = Math.abs(game.homeGoals - game.awayGoals);
    if (diff > CONFIG.MAX_SCORE_DIFF) {
      log(`⏭ ${game.home} x ${game.away} — placar desequilibrado (${game.homeGoals}x${game.awayGoals})`);
      continue;
    }

    // FILTRO 4: under score mínimo
    const underScore = calcUnderScore(game, total);
    if (underScore < CONFIG.MIN_UNDER_SCORE) {
      log(`⏭ ${game.home} x ${game.away} — Under Score baixo: ${underScore}%`);
      continue;
    }

    // FILTRO 5: meio de tabela
    if (game.competitionCode) {
      const homeMid = await isMidTable(game.homeId, game.competitionCode);
      const awayMid = await isMidTable(game.awayId, game.competitionCode);
      if (homeMid && awayMid) {
        log(`⏭ ${game.home} x ${game.away} — ambos de meio de tabela`);
        continue;
      }
    }

    // chave única
    const key = `${game.id}-${total}`;
    if (alertedGames.has(key)) continue;
    alertedGames.add(key);
    alertCount++;
    alertsThisScan++;

    log(`🚨 ALERTA #${alertCount}: ${game.home} ${game.homeGoals}x${game.awayGoals} ${game.away} — ${game.minute}' — Score: ${underScore}%`);

    const sent = await sendTelegram(buildMessage(game, total, underScore));
    log(sent ? `✈️  Telegram enviado!` : `⚠ Falha no envio Telegram`);
  }

  log(`✅ Varredura #${scanCount} concluída. Total alertas: ${alertCount}`);
}

// ── startup ──
async function start() {
  log("👑 KING UNDER v3.0 INICIADO — Football-Data.org");
  log(`🎯 Critério: ≥${CONFIG.MIN_GOALS} gols | ${CONFIG.MIN_MINUTE}' a ${CONFIG.MAX_MINUTE}'`);
  log(`📊 Under Score mínimo: ${CONFIG.MIN_UNDER_SCORE}%`);
  log(`⏱ Intervalo: ${CONFIG.INTERVAL_SEC}s`);

  await sendTelegram(
    `👑 <b>King Under v3.0 iniciado!</b>\n\n` +
    `✅ Nova fonte: Football-Data.org\n` +
    `🎯 ≥${CONFIG.MIN_GOALS} gols até o ${CONFIG.MAX_MINUTE}'\n` +
    `📊 Under Score mínimo: ${CONFIG.MIN_UNDER_SCORE}%\n` +
    `⏱ Varredura a cada ${CONFIG.INTERVAL_SEC}s`
  );

  await runScan();
  setInterval(runScan, CONFIG.INTERVAL_SEC * 1000);
}

// ── servidor HTTP ──
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`👑 King Under v3.0\nVarreduras: ${scanCount}\nAlertas: ${alertCount}`);
}).listen(process.env.PORT || 3000, () => {
  log(`🌐 Servidor na porta ${process.env.PORT || 3000}`);
  start();
});
