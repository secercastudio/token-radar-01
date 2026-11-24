// Token radar model, radar-2 — rewritten in this session.
//
// One sealed snapshot goes in, one ranked board comes out. The board ranks the
// whole clean pre-token universe: every snapshot protocol that has no token and
// is not a wrapped, staked or bridged product of something that already trades.
// The house watchlist (40 slugs) sits inside that universe; it is never the
// whole board. Nothing here names a protocol: one scoring function ranks them
// all, and the dashboard prints the calibration table it was scored from, so
// the arithmetic can be checked row by row.
//
// How a row is valued, from the snapshot's own numbers only:
//
//   multiple   median mcap / TVL of live-token protocols in the row's category
//              (three or more of them, else the global median), clamped 0.05..0.60
//   growth     change_7d clamped to -50..+120 percent, weighted 0.4
//   readiness  age with no token: 0.70 rising to 1.00 over the first 90 days,
//              1.00 through day 1095, then easing toward 0.85 for protocols
//              that have run years without ever launching
//   breadth    +0.03 per extra chain, at most four extra chains
//   implied    max(1, round(tvl x multiple x growthMult x readiness x breadth))

// ---------------------------------------------------------------- shapes

/** One protocol entry from the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Every tunable the model uses, as the dashboard states it. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  multiple_floor: number;
  multiple_cap: number;
  min_category_n: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
  young_days: number;
  young_floor: number;
  full_days: number;
  old_discount: number;
  old_span_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.4,
  growth_floor: -50,
  growth_cap: 120,
  multiple_floor: 0.05,
  multiple_cap: 0.6,
  min_category_n: 3,
  breadth_per_chain: 0.03,
  breadth_max_chains: 4,
  young_days: 90,
  young_floor: 0.7,
  full_days: 1095,
  old_discount: 0.15,
  old_span_days: 1460,
  unknown_age_days: 365,
};

/** The model's version label, named by the dashboard and quoted by the rules. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard's Live token view carries. */
export const LIVE_ROWS = 24;

/** One category's calibration: the median traded multiple borrowed from it. */
export interface CategoryCalibration {
  category: string;
  multiple: number;
  n: number;
}

/** One farm step before it is flattened to a single string. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    readiness_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row in the compact form data.js carries; the page builds farm plans from it. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  readiness_multiplier: number;
  breadth_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs to render: the board, the live set, the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_multiple: number;
  calibration: CategoryCalibration[];
  watchlist_slugs: string[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** The headline figures: watchlist size, board size, early rows, live rows set aside. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------- small tools

const MS_PER_DAY = 86_400_000;

/** Round to four decimals; the dashboard's multipliers are shown at this precision. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, or `fallback` when the value is missing or not finite. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list, averaging the two middle values when even. */
function medianOf(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle]!;
  return (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/** A multiple kept inside the model's floor and cap. */
function clampToModel(v: number, model: ModelConstants): number {
  if (v < model.multiple_floor) return model.multiple_floor;
  if (v > model.multiple_cap) return model.multiple_cap;
  return v;
}

/** Whole days from `listed` to `asOf`, never below zero; null when either date is unusable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
}

// ---------------------------------------------------------------- multipliers

/** Launch readiness from age: unproven when young, full in mid-life, gently discounted when old. */
export function readinessMultiplier(age: number | null, model: ModelConstants = MODEL): number {
  const days = age ?? model.unknown_age_days;
  if (days < model.young_days) {
    const rise = (1 - model.young_floor) * (Math.max(days, 0) / model.young_days);
    return model.young_floor + rise;
  }
  if (days <= model.full_days) return 1;
  const pastFull = Math.min(1, (days - model.full_days) / model.old_span_days);
  const eased = 1 - model.old_discount * pastFull;
  return Math.max(1 - model.old_discount, eased);
}

/** Chain breadth: each extra chain up to the cap adds a little reach. */
export function breadthMultiplier(chains: string[], model: ModelConstants = MODEL): number {
  const extra = Math.min(Math.max(chains.length - 1, 0), model.breadth_max_chains);
  return 1 + model.breadth_per_chain * extra;
}

// ---------------------------------------------------------------- calibration

export interface Calibration {
  byCategory: Map<string, number>;
  global: number;
  table: CategoryCalibration[];
}

/**
 * The calibration, computed from this snapshot alone at run time: for every
 * category with at least `min_category_n` live-token protocols, the median
 * market-cap / TVL of those protocols; the global median for every other
 * category. A protocol only lends its ratio when it actually trades — a
 * market cap, a positive TVL, and a gecko id or a symbol on record.
 */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const perCategory = new Map<string, number[]>();
  const everyRatio: number[] = [];
  for (const proto of snapshot.protocols) {
    if (proto.mcap_usd === null) continue;
    if (proto.tvl_usd <= 0) continue;
    if (proto.gecko_id === null && proto.symbol === null) continue;
    const ratio = proto.mcap_usd / proto.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    everyRatio.push(ratio);
    const bucket = proto.category ?? 'Other';
    const list = perCategory.get(bucket) ?? [];
    list.push(ratio);
    perCategory.set(bucket, list);
  }
  const global = everyRatio.length > 0 ? clampToModel(medianOf(everyRatio), model) : 0.2;
  const byCategory = new Map<string, number>();
  const table: CategoryCalibration[] = [];
  const names = [...perCategory.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const ratios = perCategory.get(name)!;
    if (ratios.length < model.min_category_n) continue;
    const multiple = clampToModel(medianOf(ratios), model);
    byCategory.set(name, multiple);
    table.push({ category: name, multiple: round4(multiple), n: ratios.length });
  }
  return { byCategory, global, table };
}

/** The multiple a protocol borrows: its own category's, or the global one. */
export function categoryMultiple(p: SnapshotProtocol, cal: Calibration): number {
  return cal.byCategory.get(p.category ?? 'Other') ?? cal.global;
}

// ---------------------------------------------------------------- scoring

export interface ScoredProtocol {
  implied: number;
  catMult: number;
  growthPct: number;
  growthMult: number;
  readinessMult: number;
  breadthMult: number;
  age: number | null;
}

/** The multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  cal: Calibration,
  model: ModelConstants = MODEL,
): ScoredProtocol {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finiteOr(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const readinessMult = readinessMultiplier(age, model);
  const breadthMult = breadthMultiplier(protocol.chains, model);
  const catMult = categoryMultiple(protocol, cal);
  const raw = protocol.tvl_usd * catMult * growthMult * readinessMult * breadthMult;
  const implied = Math.max(1, Math.round(raw));
  return { implied, catMult, growthPct, growthMult, readinessMult, breadthMult, age };
}

// ---------------------------------------------------------------- eligibility

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names a pre-token protocol must not begin with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token and not a wrapped, staked or bridged product. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  const words = p.name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.includes('wrapped') || words.includes('staked') || words.includes('staking')) return false;
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return false;
  return true;
}

/** The snapshot's protocols keyed by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const proto of protocols) index.set(proto.slug, proto);
  return index;
}

// ---------------------------------------------------------------- farm plans

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const kind = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (kind.includes('lend') || kind.includes('cdp') || kind.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (kind.includes('dex') || kind.includes('yield') || kind.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (kind.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (kind.includes('staking') || kind.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (kind.includes('perpetual') || kind.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (kind.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (kind.includes('curator') || kind.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (kind.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (kind.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (kind.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let joined = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (joined.length > 600) joined = `${joined.slice(0, 596)}...`;
  if (joined.length < 20) joined = `${joined} Hold the position and check the protocol's own page.`;
  return joined;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const secondChain =
    p.chains.length > 1
      ? ` Repeat the same position on ${p.chains[1]} only if the protocol counts activity there.`
      : ` Keep the whole position on ${chain} so every action counts toward the same record.`;
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.${secondChain}`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Open the protocol's own points or rewards page once a week and check whether your wallet shows activity, a rank or points.`,
      cost: 'no fee to check',
      time: '5 minutes a week',
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Treat every direct message, airdrop checker site and paid claim link as a scam: the protocol never asks for your seed phrase or a fee to claim.`,
      cost: 'nothing, and it saves the whole position',
      time: '2 minutes to verify the link',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---------------------------------------------------------------- board assembly

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const cal = calibrate(snapshot, model);
  const rankable = snapshot.protocols.filter(isRankable);
  const scored = rankable.map((proto) => {
    const score = impliedValue(proto, snapshot.as_of, cal, model);
    return { proto, score };
  });
  scored.sort((a, b) => {
    if (b.score.implied !== a.score.implied) return b.score.implied - a.score.implied;
    if (a.proto.slug < b.proto.slug) return -1;
    if (a.proto.slug > b.proto.slug) return 1;
    return 0;
  });
  return scored.map((entry, index) => {
    const proto = entry.proto;
    const score = entry.score;
    return {
      rank: index + 1,
      slug: proto.slug,
      name: proto.name,
      category: proto.category,
      chains: proto.chains,
      tvl_usd: proto.tvl_usd,
      change_7d: proto.change_7d,
      mcap_usd: proto.mcap_usd,
      listed_at: proto.listed_at,
      gecko_id: proto.gecko_id,
      symbol: proto.symbol,
      token_status: 'pre-token',
      age_days: score.age,
      implied_value_usd: score.implied,
      model: {
        // Full precision here: the page recomputes the row from this value and
        // must match board.json exactly, so it is never rounded.
        category_multiple: score.catMult,
        growth_pct: score.growthPct,
        growth_multiplier: round4(score.growthMult),
        readiness_multiplier: round4(score.readinessMult),
        breadth_multiplier: round4(score.breadthMult),
        age_days: score.age,
      },
      farm_steps: farmSteps(proto, score.age).map(stepText),
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  live.sort((a, b) => {
    const capDiff = (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0);
    if (capDiff !== 0) return capDiff;
    return b.tvl_usd - a.tvl_usd;
  });
  return live.slice(0, LIVE_ROWS).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    readiness_multiplier: row.model.readiness_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const cal = calibrate(snapshot, model);
  const early = board.filter((row) => !snapshot.watchlist.includes(row.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_multiple: round4(cal.global),
    calibration: cal.table,
    watchlist_slugs: snapshot.watchlist,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------- snapshot parsing

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof doc.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = doc.protocols.map((value, i) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = value as Record<string, unknown>;
    const usable =
      typeof p.slug === 'string' && typeof p.name === 'string' && typeof p.tvl_usd === 'number' && Number.isFinite(p.tvl_usd);
    if (!usable) throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    const numberOrNull = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    const stringOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return {
      slug: p.slug as string,
      name: p.name as string,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd as number,
      change_7d: numberOrNull(p.change_7d),
      mcap_usd: numberOrNull(p.mcap_usd),
      listed_at: stringOrNull(p.listed_at),
      gecko_id: stringOrNull(p.gecko_id),
      symbol: stringOrNull(p.symbol),
    };
  });
  return {
    as_of: doc.as_of as string,
    source: doc.source as string,
    floor_usd: doc.floor_usd as number,
    protocols,
    watchlist: doc.watchlist as string[],
  };
}

// ---------------------------------------------------------------- gate checks

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const present = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !present.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const row of board) {
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug} has ${row.farm_steps.length} farm steps`;
    }
    for (const step of row.farm_steps) {
      if (step.length < 20 || step.length > 600) return `${row.slug} has a farm step of ${step.length} characters`;
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
