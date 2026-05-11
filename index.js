const axios = require("axios");
const http  = require("http");

// ══════════════════════════════════════════════
//  KING UNDER — Agente 24h v2.0
//  Filtros avançados ativos
// ══════════════════════════════════════════════

const CONFIG = {
  TELEGRAM_TOKEN:      process.env.TELEGRAM_TOKEN,
  CHAT_ID:             process.env.CHAT_ID,
  API_KEY:             process.env.API_KEY,
  MIN_GOALS:           parseInt(process.env.MIN_GOALS           || "2"),
  MAX_MINUTE:          parseInt(process.env.MAX_MINUTE          || "35"),
  MIN_MINUTE:          parseInt(process.env.MIN_MINUTE          || "10"),
  MAX_ODDS:            parseFloat(process.env.MAX_ODDS          || "1.65"),
  MIN_ODDS:            parseFloat(process.env.MIN_ODDS          || "1.25"),
  MAX_SCORE_DIFF:      parseInt(process.env.MAX_SCORE_DIFF      || "1"),
  MIN_UNDER_SCORE:     parseInt(process.env.MIN_UNDER_SCORE     || "70"),
  MAX_ALERTS_PER_SCAN: parseInt(process.env.MAX_ALERTS_PER_SCAN || "3"),
  FILTER_MID_TABLE:    process.env.FILTER_MID_TABLE === "true",
  INTERVAL_SEC:        parseInt(process.env.INTERVAL_SEC        || "120"),
};

// ── Ligas top tier permitidas ──
const TOP_LEAGUES = [
  "uefa champions league",
  "uefa europa league",
  "uefa europa conference league",
  "premier league",
  "la liga",
  "bundesliga",
  "serie a",
  "ligue 1",
  "eredivisie",
  "primeira liga",
  "super lig",
  "belgian pro league",
  "scottish premiership",
  "copa libertadores",
  "copa sudamericana",
  "recopa sudamericana",
  "copa do brasil",
  "serie b",
  "liga profesional argentina",
  "primera división",
  "mls",
  "saudi pro league",
  "liga mx",
];

const alertedGames  = new Set();
const standingsCache = {};
let scanCount  = 0;
let alertCount = 0;

function log(msg) {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  console.log(`[${now}] ${msg}`);
}

// ── busca standings para verificar posição na tabela ──
async function fetchStandings(leagueId, season) {
  const key = `${leagueId}_${season}`;
  if (standingsCache[key]) return standingsCache[key];
  try {
    const res = await axios.get(
      `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${season}`,
      { headers: { "x-apisports-key": CONFIG.API_KEY }, timeout: 8000 }
    );
    const standings = res.data?.response?.[0]?.league?.standings?.[0] || [];
    standingsCache[key] = standings;
    setTimeout(() => delete standingsCache[key], 30 * 60 * 1000);
    return standings;
  } catch {
    return [];
  }
}

// ── verifica se time está no meio da tabela ──
async function isMidTable(teamId, leagueId, season) {
  if (!CONFIG.FILTER_MID_TABLE) return false;
  const standings = await fetchStandings(leagueId, season);
  if (!standings.length) return false;
  const total = standings.length;
  const entry = standings.find(s => s.team.id === teamId);
  if (!entry) return false;
  const pos        = entry.rank;
  const topZone    = 6;
  const bottomZone = total - 5;
  return pos > topZone && pos < bottomZone;
}

// ── busca jogos ao vivo ──
async function fetchLiveGames() {
  try {
    const res = await axios.get("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: { "x-apisports-key": CONFIG.API_KEY },
      timeout: 10000,
    });
    if (!res.data?.response) return [];
    return res.data.response.map(f => ({
      id:        f.fixture.id.toString(),
      home:      f.teams.home.name,
      homeId:    f.teams.home.id,
      away:      f.teams.away.name,
      awayId:    f.teams.away.id,
      league:    f.league.name,
      leagueId:  f.league.id,
      season:    f.league.season,
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

// ── verifica liga top tier ──
function isTopLeague(leagueName) {
  const name = leagueName.toLowerCase();
  return TOP_LEAGUES.some(l => name.includes(l));
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

  const rate = total / game.minute;
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

⚠️ <i>King Under v2 · Aposte com responsabilidade.</i>`;
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

  const games = await fetchLiveGames();
  log(`📋 ${games.length} jogos ao vivo encontrados`);

  let alertsThisScan = 0;

  for (const game of games) {
    if (alertsThisScan >= CONFIG.MAX_ALERTS_PER_SCAN) {
      log(`⚠ Limite de ${CONFIG.MAX_ALERTS_PER_SCAN} alertas atingido nesta varredura`);
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

    // FILTRO 4: liga top tier
    if (!isTopLeague(game.league)) {
      log(`⏭ Liga ignorada: ${game.league}`);
      continue;
    }

    // FILTRO 5: under score mínimo
    const underScore = calcUnderScore(game, total);
    if (underScore < CONFIG.MIN_UNDER_SCORE) {
      log(`⏭ ${game.home} x ${game.away} — Under Score insuficiente: ${underScore}%`);
      continue;
    }

    // FILTRO 6: meio de tabela
    if (CONFIG.FILTER_MID_TABLE) {
      const homeMid = await isMidTable(game.homeId, game.leagueId, game.season);
      const awayMid = await isMidTable(game.awayId, game.leagueId, game.season);
      if (homeMid && awayMid) {
        log(`⏭ ${game.home} x ${game.away} — ambos times de meio de tabela`);
        continue;
      }
    }

    // chave única para não repetir alerta
    const key = `${game.id}-${total}`;
    if (alertedGames.has(key)) continue;
    alertedGames.add(key);
    alertCount++;
    alertsThisScan++;

    log(`🚨 ALERTA #${alertCount}: ${game.home} ${game.homeGoals}x${game.awayGoals} ${game.away} — ${game.minute}' — Score: ${underScore}%`);

    const msg  = buildMessage(game, total, underScore);
    const sent = await sendTelegram(msg);
    log(sent ? `✈️  Telegram enviado!` : `⚠ Falha no envio Telegram`);
  }

  log(`✅ Varredura #${scanCount} concluída. Total alertas: ${alertCount}`);
}

// ── startup ──
async function start() {
  log("👑 KING UNDER v2.0 INICIADO");
  log(`🎯 Critério: ≥${CONFIG.MIN_GOALS} gols | ${CONFIG.MIN_MINUTE}' a ${CONFIG.MAX_MINUTE}'`);
  log(`📊 Under Score mínimo: ${CONFIG.MIN_UNDER_SCORE}%`);
  log(`🏆 Apenas ligas top tier`);
  log(`⚽ Filtro meio de tabela: ${CONFIG.FILTER_MID_TABLE ? "ativo" : "inativo"}`);
  log(`⏱ Intervalo: ${CONFIG.INTERVAL_SEC}s`);

  await sendTelegram(
    `👑 <b>King Under v2.0 iniciado!</b>\n\n` +
    `✅ Filtros avançados ativos\n` +
    `🎯 ≥${CONFIG.MIN_GOALS} gols até o ${CONFIG.MAX_MINUTE}'\n` +
    `📊 Under Score mínimo: ${CONFIG.MIN_UNDER_SCORE}%\n` +
    `🏆 Apenas ligas top tier\n` +
    `⚽ Sem times de meio de tabela\n` +
    `⏱ Varredura a cada ${CONFIG.INTERVAL_SEC}s`
  );

  await runScan();
  setInterval(runScan, CONFIG.INTERVAL_SEC * 1000);
}

// ── servidor HTTP (Render exige porta aberta) ──
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`👑 King Under v2.0\nVarreduras: ${scanCount}\nAlertas: ${alertCount}`);
}).listen(process.env.PORT || 3000, () => {
  log(`🌐 Servidor na porta ${process.env.PORT || 3000}`);
  start();
});
