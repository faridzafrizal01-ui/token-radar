// How the radar turns one sealed snapshot into a ranked board.
//
// The board always covers the snapshot's watchlist in full — that is the floor, not the ceiling —
// and on top of it the radar adds pre-token protocols sitting below the watchlist floor, which is
// the whole point of the early radar. A protocol counts as pre-token when its index entry shows no
// token at all: no market cap, no CoinGecko id, no symbol. Protocols that already have a token are
// held aside and shown with the market's own numbers, never blended into the ranking.
//
// Implied value comes only from numbers the snapshot itself carries. The base multiple is
// DATA-DRIVEN: per category, the median market-cap/TVL ratio of that category's live-token
// protocols, clamped to [0.05, 1.50]; a category with fewer than 3 live protocols falls back to
// 0.25, the starter's flat multiple. A protocol on several chains earns a small diversity factor.
//
//   baseMultiple = category_multiple(category)          // median live mcap/TVL, [0.05, 1.50], else 0.25
//   base       = tvl_usd x baseMultiple
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   chainMult  = 1 + 0.02 x min(max(chains - 1, 0), 4)    // up to +8% for multi-chain
//   implied    = max(1, round(base x growthMult x maturity x chainMult))
//
// The constants belong to the house model; the dashboard states them and the sandbox can change
// them. No protocol name ever gets special treatment: one function scores every row.

/** One protocol entry from the snapshot: exactly the ten fields the sealed input carries. */
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

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_max_steps: number;
  /** Per-category base multiples, computed from the snapshot's live protocols; empty in the static
   *  MODEL, filled by resolveModel. A missing category falls back to base_multiple. */
  category_multiples: Record<string, number>;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.02,
  chain_max_steps: 4,
  category_multiples: {},
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A live protocol counts toward its category's multiple only with this many peers. */
export const CATEGORY_MIN_LIVE = 3;
/** The clamp on a category's median market-cap/TVL ratio. */
export const CATEGORY_MULTIPLE_MIN = 0.05;
export const CATEGORY_MULTIPLE_MAX = 1.5;
/** The key a protocol with no category is grouped under. */
export const OTHER_CATEGORY = 'Other';

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
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
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
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
  base_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
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
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const listedMs = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.max(0, Math.floor((asOfMs - listedMs) / DAY_MS));
}

/** The median of a sorted list of numbers; the mean of the two middles when even. */
function middleOf(sorted: number[]): number {
  const count = sorted.length;
  const half = Math.floor(count / 2);
  return count % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
}

/**
 * The per-category base multiple, from the snapshot's own live protocols: for each category, the
 * median market-cap/TVL ratio of its live-token protocols (a token on record: market cap, CoinGecko id
 * and symbol all present), clamped to [CATEGORY_MULTIPLE_MIN, CATEGORY_MULTIPLE_MAX]. A category with
 * fewer than CATEGORY_MIN_LIVE live protocols is left out and falls back to base_multiple. No protocol
 * name is consulted: the map is keyed by category only.
 */
export function categoryMultiples(snapshot: Snapshot): Record<string, number> {
  const byCategory = new Map<string, number[]>();
  for (const proto of snapshot.protocols) {
    if (proto.mcap_usd === null || proto.gecko_id === null || proto.symbol === null) continue;
    if (!(proto.tvl_usd > 0) || !(proto.mcap_usd >= 0)) continue;
    const cat = proto.category ?? OTHER_CATEGORY;
    const values = byCategory.get(cat);
    if (values === undefined) byCategory.set(cat, [proto.mcap_usd / proto.tvl_usd]);
    else values.push(proto.mcap_usd / proto.tvl_usd);
  }
  const multiples: Record<string, number> = {};
  const ordered = [...byCategory.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  for (const [cat, values] of ordered) {
    if (values.length < CATEGORY_MIN_LIVE) continue;
    const mid = middleOf([...values].sort((a, b) => a - b));
    multiples[cat] = Math.round(Math.min(CATEGORY_MULTIPLE_MAX, Math.max(CATEGORY_MULTIPLE_MIN, mid)) * 1e4) / 1e4;
  }
  return multiples;
}

/** The model with the snapshot's category multiples resolved: the model the board is scored with. */
export function resolveModel(snapshot: Snapshot, model: ModelConstants = MODEL): ModelConstants {
  return { ...model, category_multiples: categoryMultiples(snapshot) };
}

/** The base multiple one protocol's category earns under `model`, else the flat fallback. */
export function categoryMultipleFor(category: string | null, model: ModelConstants): number {
  return model.category_multiples[category ?? OTHER_CATEGORY] ?? model.base_multiple;
}

/** The chain-diversity factor: 1 + chain_step per extra chain, up to chain_max_steps steps. */
export function chainMultiplier(protocol: SnapshotProtocol, model: ModelConstants): number {
  const extra = Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_max_steps);
  return 1 + model.chain_step * extra;
}

/** The multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { implied: number; baseMultiple: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawChange = numOr(protocol.change_7d, 0);
  const clampedGrowth = Math.min(model.growth_cap, Math.max(model.growth_floor, rawChange));
  const growthFactor = 1 + (clampedGrowth / 100) * model.growth_weight;
  const ageUsed = age ?? model.unknown_age_days;
  const maturityFactor = model.maturity_floor + (Math.min(Math.max(ageUsed, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const multiple = categoryMultipleFor(protocol.category, model);
  const chainFactor = chainMultiplier(protocol, model);
  const baseValue = protocol.tvl_usd * multiple;
  const value = Math.max(1, Math.round(baseValue * growthFactor * maturityFactor * chainFactor));
  return { implied: value, baseMultiple: multiple, growthPct: clampedGrowth, growthMult: growthFactor, maturityMult: maturityFactor, chainMult: chainFactor, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(proto: SnapshotProtocol): boolean {
  return proto.mcap_usd === null && proto.gecko_id === null && proto.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(proto: SnapshotProtocol): boolean {
  return isPreToken(proto) && proto.category !== 'CEX' && !VERSIONED.test(proto.name);
}

/** The snapshot's protocol by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((proto) => [proto.slug, proto]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const scoredModel = resolveModel(snapshot, model);
  const lookup = indexBySlug(snapshot.protocols);
  const picked = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const proto = lookup.get(slug);
    if (proto !== undefined) picked.set(slug, proto);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a
  // replacement for a watchlist row: a picked protocol stays picked.
  const belowFloor = snapshot.protocols.filter((proto) => !picked.has(proto.slug) && isRankable(proto) && proto.tvl_usd < snapshot.floor_usd);
  const byTvl = [...belowFloor].sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const earlyPicks = byTvl.slice(0, EARLY_ROWS);
  for (const proto of earlyPicks) picked.set(proto.slug, proto);

  const scored = [...picked.values()].map((proto) => ({ proto, ...impliedValue(proto, snapshot.as_of, scoredModel) }));
  scored.sort((a, b) => b.implied - a.implied || (a.proto.slug < b.proto.slug ? -1 : a.proto.slug > b.proto.slug ? 1 : 0));
  return scored.map((entry, i) => ({
    rank: i + 1,
    slug: entry.proto.slug,
    name: entry.proto.name,
    category: entry.proto.category,
    chains: entry.proto.chains,
    tvl_usd: entry.proto.tvl_usd,
    change_7d: entry.proto.change_7d,
    mcap_usd: entry.proto.mcap_usd,
    listed_at: entry.proto.listed_at,
    gecko_id: entry.proto.gecko_id,
    symbol: entry.proto.symbol,
    token_status: 'pre-token',
    age_days: entry.age,
    implied_value_usd: entry.implied,
    model: {
      base_multiple: round4dp(entry.baseMultiple),
      growth_pct: entry.growthPct,
      growth_multiplier: round4dp(entry.growthMult),
      maturity_multiplier: round4dp(entry.maturityMult),
      chain_multiplier: round4dp(entry.chainMult),
      age_days: entry.age,
    },
    farm_steps: farmSteps(entry.proto, entry.age).map(stepText),
  }));
}

const round4dp = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(proto: SnapshotProtocol): string {
  return proto.chains.length > 0 ? proto.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeSize(proto: SnapshotProtocol): number {
  if (proto.tvl_usd >= 5_000_000_000) return 250;
  if (proto.tvl_usd >= 1_000_000_000) return 150;
  if (proto.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdWindow(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function planAction(proto: SnapshotProtocol, capital: number, chain: string): string {
  const c = (proto.category ?? '').toLowerCase();
  const name = proto.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(proto: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(proto);
  const capital = stakeSize(proto);
  const hold = holdWindow(age);
  const action = planAction(proto, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((proto) => !isPreToken(proto) && proto.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((proto) => ({
      slug: proto.slug,
      name: proto.name,
      category: proto.category,
      chains: proto.chains,
      tvl_usd: proto.tvl_usd,
      mcap_usd: proto.mcap_usd,
      change_7d: proto.change_7d,
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
    base_multiple: row.model.base_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const scoredModel = resolveModel(snapshot, model);
  const ranked = buildBoard(snapshot, scoredModel);
  const liveSet = liveRows(snapshot);
  const earlyCount = ranked.filter((row) => !snapshot.watchlist.includes(row.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: scoredModel,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: ranked.length,
    early_size: earlyCount,
    live_size: liveSet.length,
    rows: ranked.map(radarRow),
    live: liveSet,
  };
  return { board: ranked, radar };
}

/** One protocol entry out of its raw JSON value, refused unless it carries a slug, a name and a TVL. */
function normalizeProtocol(v: unknown, i: number): SnapshotProtocol {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  return {
    slug: p.slug,
    name: p.name,
    category: typeof p.category === 'string' ? p.category : null,
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: p.tvl_usd,
    change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
    mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
    gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
    symbol: typeof p.symbol === 'string' ? p.symbol : null,
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => normalizeProtocol(v, i));
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const onBoard = new Set(board.map((row) => row.slug));
  const absent = snapshot.watchlist.filter((slug) => !onBoard.has(slug));
  if (absent.length > 0) return `the board misses ${absent.length} watchlist slug${absent.length === 1 ? '' : 's'}: ${absent.slice(0, 5).join(', ')}`;
  const rankList = board.map((row) => row.rank).sort((a, b) => a - b);
  for (let i = 0; i < rankList.length; i++) if (rankList[i] !== i + 1) return `rank ${i + 1} is ${rankList[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const row of board) {
    const steps = row.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${row.slug} has ${steps.length} farm steps`;
    for (const step of steps) if (step.length < 20 || step.length > 600) return `${row.slug} has a farm step of ${step.length} characters`;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return `${row.slug} has implied value ${row.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
