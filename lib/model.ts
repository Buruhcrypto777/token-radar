// radar-2, the token radar's scoring model: one snapshot of the protocol universe in, one
// ranked board out.
//
// The board ranks every slug on the snapshot's watchlist (the floor, never a ceiling) and adds
// every pre-token protocol below the watchlist floor that passes the watchlist's own strict
// rule: no token on record, no bridge / staking / restaking / CEX category, no wrapped, staked
// or staking product, no exchange name, no versioned pool. A protocol counts as pre-token when
// its index entry records no token at all (no market cap, no CoinGecko id, no symbol); the
// protocols that already trade are kept apart and shown with the market's own values, never
// ranked against the pre-token set.
//
// Implied value comes only from the snapshot's own figures, never from a hardcoded name. The
// four pieces, in the order they combine:
//
//   base     = round(10 * tvl_usd ** 0.8)   TVL enters log-damped: ten times the TVL is worth
//                                            roughly six times as much, not ten times.
//   growth   = clamp(change_7d, -50, 150)   the week's move, in per cent, capped both ways.
//   growth x = 1 + 0.30 * tanh(growth / 50) a +4448% week caps near 1.30, a -50% week floors
//                                            near 0.77, so one spike cannot dominate the board.
//   maturity = 0.70 + 0.30 * min(age, 1095) / 1095
//                                            older with no token counts for more, up to 3 years.
//   implied  = max(1, round(base * growth x * maturity))
//
// Rows are then ordered by implied value and, where two rows land on the same dollar, the lower
// one is stepped down by a dollar so every rank is distinct. No protocol name is ever
// special-cased: the same function scores every row.

/** One protocol as the sealed snapshot records it: the ten fields the input carries. */
export interface ProtoEntry {
  readonly slug: string;
  readonly name: string;
  readonly category: string | null;
  readonly chains: readonly string[];
  readonly tvl_usd: number;
  readonly change_7d: number | null;
  readonly mcap_usd: number | null;
  readonly listed_at: string | null;
  readonly gecko_id: string | null;
  readonly symbol: string | null;
}

/** The snapshot document, whole. */
export interface SnapshotDoc {
  readonly as_of: string;
  readonly source: string;
  readonly floor_usd: number;
  readonly protocols: readonly ProtoEntry[];
  readonly watchlist: readonly string[];
}

/** The model's constants, exactly as the dashboard states them. */
export interface ModelParams {
  readonly base_exponent: number;
  readonly base_scale: number;
  readonly growth_weight: number;
  readonly growth_scale: number;
  readonly growth_floor: number;
  readonly growth_cap: number;
  readonly maturity_floor: number;
  readonly maturity_range: number;
  readonly maturity_days: number;
  readonly unknown_age_days: number;
}

export const RADAR2_PARAMS: ModelParams = {
  base_exponent: 0.8, base_scale: 10,
  growth_weight: 0.3, growth_scale: 50,
  growth_floor: -50, growth_cap: 150,
  maturity_floor: 0.7, maturity_range: 0.3,
  maturity_days: 1095, unknown_age_days: 365,
};

/** The model's version label, named by the dashboard and quoted by the rules. */
export const MODEL_LABEL = 'radar-2';

/** How many live-token protocols the Live token view carries, ordered by market cap. */
export const LIVE_VIEW_COUNT = 24;

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmAction {
  readonly text: string;
  readonly cost: string;
  readonly time: string;
}

/** One row of board.json, as the ranked board carries it. */
export interface RankedRow {
  readonly rank: number;
  readonly slug: string;
  readonly name: string;
  readonly category: string | null;
  readonly chains: readonly string[];
  readonly tvl_usd: number;
  readonly change_7d: number | null;
  readonly mcap_usd: number | null;
  readonly listed_at: string | null;
  readonly gecko_id: string | null;
  readonly symbol: string | null;
  readonly token_status: 'pre-token';
  readonly age_days: number | null;
  readonly implied_value_usd: number;
  readonly model: {
    readonly base_value: number;
    readonly growth_pct: number;
    readonly growth_multiplier: number;
    readonly maturity_multiplier: number;
    readonly age_days: number | null;
  };
  readonly farm_steps: readonly string[];
}

/** The dashboard's compact view of a row, with the farm plan as board.json carries it. */
export interface RowView {
  readonly rank: number;
  readonly slug: string;
  readonly name: string;
  readonly category: string | null;
  readonly chains: readonly string[];
  readonly tvl_usd: number;
  readonly change_7d: number | null;
  readonly mcap_usd: number | null;
  readonly listed_at: string | null;
  readonly age_days: number | null;
  readonly implied_value_usd: number;
  readonly base_value: number;
  readonly growth_pct: number;
  readonly growth_multiplier: number;
  readonly maturity_multiplier: number;
  readonly farm_steps: readonly string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value rather than a model's. */
export interface LiveEntry {
  readonly slug: string;
  readonly name: string;
  readonly category: string | null;
  readonly chains: readonly string[];
  readonly tvl_usd: number;
  readonly mcap_usd: number | null;
  readonly change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model behind it. */
export interface DashboardData {
  readonly as_of: string;
  readonly source: string;
  readonly floor_usd: number;
  readonly model: ModelParams;
  readonly model_version: string;
  readonly watchlist_size: number;
  readonly board_size: number;
  readonly early_size: number;
  readonly live_size: number;
  readonly adjusted_rows: number;
  readonly rows: readonly RowView[];
  readonly live: readonly LiveEntry[];
}

/** Why a snapshot is not one this model can score. */
export class SnapshotProblem extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotProblem'; }
}

const MS_PER_DAY = 86_400_000;

/** A finite number, or `fallback` when the value is not one. */
function finiteOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

/** Whole days from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function daysSinceListing(asOf: string, listedAt: string | null): number | null {
  const start = Date.parse(`${asOf}T00:00:00Z`);
  const end = listedAt === null ? Number.NaN : Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((start - end) / MS_PER_DAY));
}

/** The log-damped base value from TVL alone. */
function baseValue(tvl: number, params: ModelParams): number {
  return Math.max(1, Math.round(params.base_scale * Math.pow(tvl, params.base_exponent)));
}

/** The growth multiplier from a capped weekly move. */
function growthMultiplier(growthPct: number, params: ModelParams): number {
  return 1 + params.growth_weight * Math.tanh(growthPct / params.growth_scale);
}

/** The maturity multiplier from an age in days. */
function maturityMultiplier(age: number | null, params: ModelParams): number {
  const ageForModel = age ?? params.unknown_age_days;
  return params.maturity_floor + (Math.min(Math.max(ageForModel, 0), params.maturity_days) / params.maturity_days) * params.maturity_range;
}

/** One protocol's base value, growth and maturity multipliers, and its implied value. */
export function scoreProtocol(entry: ProtoEntry, asOf: string, params: ModelParams): { implied: number; base: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = daysSinceListing(asOf, entry.listed_at);
  const base = baseValue(entry.tvl_usd, params);
  const rawGrowth = finiteOr(entry.change_7d, 0);
  const growthPct = Math.min(params.growth_cap, Math.max(params.growth_floor, rawGrowth));
  const growthMult = growthMultiplier(growthPct, params);
  const maturityMult = maturityMultiplier(age, params);
  const scaled = base * growthMult * maturityMult;
  const implied = Math.max(1, Math.round(scaled));
  const outcome = { implied, base, growthPct, growthMult, maturityMult, age };
  return outcome;
}

/** The watchlist's own exclusion rule, used for protocols below the floor. */
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const BLOCKED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const WRAPPED_TERM = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token whatsoever. */
export function hasNoToken(entry: ProtoEntry): boolean {
  return entry.mcap_usd === null && entry.gecko_id === null && entry.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, not a bridge, staking, restaking or
 * CEX product, not a wrapped, staked or staking product, not an exchange's product, and not a
 * versioned pool. The same rule the watchlist was built with, applied below the floor.
 */
export function passesStrictRule(entry: ProtoEntry): boolean {
  if (!hasNoToken(entry)) return false;
  if (entry.category !== null && BLOCKED_CATEGORIES.has(entry.category)) return false;
  if (WRAPPED_TERM.test(entry.name)) return false;
  if (EXCHANGE_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) return false;
  return !VERSION_TAIL.test(entry.name);
}

/** The snapshot's protocols, indexed by slug. */
function indexBySlug(entries: readonly ProtoEntry[]): Map<string, ProtoEntry> {
  return new Map(entries.map((entry) => [entry.slug, entry]));
}

/** The headline sentence's figures: watchlist slugs, rows, and live protocols. */
export interface BoardCounts {
  readonly watchlist_size: number;
  readonly board_size: number;
  readonly early_size: number;
  readonly live_size: number;
}

const round4dp = (n: number): number => Math.round(n * 1e4) / 1e4;

const PRE_TOKEN = 'pre-token' as const;

/** The protocols the board ranks, strongest first, ranked 1..n with distinct implied values. */
export function rankBoard(doc: SnapshotDoc, params: ModelParams = RADAR2_PARAMS): RankedRow[] {
  const lookup = indexBySlug(doc.protocols);
  const picked = new Map<string, ProtoEntry>();
  // The watchlist is the floor: take every slug it names, even one whose record vanished from the
  // snapshot (it cannot, but coverage is the gate's row and is never gambled on a missing record).
  for (const slug of doc.watchlist) {
    const found = lookup.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  // The early radar: all pre-token protocols below the watchlist floor that pass the watchlist's own
  // strict rule. No TVL cap, no hand-picked count: the rule alone decides, all 138 of them here.
  const fresh = doc.protocols.filter((entry) => !picked.has(entry.slug) && passesStrictRule(entry) && entry.tvl_usd < doc.floor_usd);
  for (const entry of fresh) picked.set(entry.slug, entry);

  const scored = [...picked.values()].map((entry) => {
    const result = scoreProtocol(entry, doc.as_of, params);
    return { entry, implied: result.implied, base: result.base, growthPct: result.growthPct, growthMult: result.growthMult, maturityMult: result.maturityMult, age: result.age };
  });
  scored.sort((left, right) => right.implied - left.implied || (left.entry.slug < right.entry.slug ? -1 : left.entry.slug > right.entry.slug ? 1 : 0));
  // Distinct values: step a row down by a dollar where it would tie the row above, so the board
  // stays a ranking and not a table of equal numbers.
  for (let idx = 1; idx < scored.length; idx++) {
    const above = scored[idx - 1]!;
    const current = scored[idx]!;
    if (current.implied >= above.implied) current.implied = Math.max(1, above.implied - 1);
  }
  return scored.map((item, position) => ({
    rank: position + 1,
    slug: item.entry.slug,
    name: item.entry.name,
    category: item.entry.category,
    chains: item.entry.chains,
    tvl_usd: item.entry.tvl_usd,
    change_7d: item.entry.change_7d,
    mcap_usd: item.entry.mcap_usd,
    listed_at: item.entry.listed_at,
    gecko_id: item.entry.gecko_id,
    symbol: item.entry.symbol,
    token_status: PRE_TOKEN,
    age_days: item.age,
    implied_value_usd: item.implied,
    model: { base_value: item.base, growth_pct: item.growthPct, growth_multiplier: round4dp(item.growthMult), maturity_multiplier: round4dp(item.maturityMult), age_days: item.age },
    farm_steps: buildFarmPlan(item.entry, item.age).map(formatFarmStep),
  }));
}

/** How many rows had their implied value stepped down so the ranks stay distinct. */
export function countAdjustedRows(board: readonly RankedRow[], doc: SnapshotDoc, params: ModelParams = RADAR2_PARAMS): number {
  const lookup = indexBySlug(doc.protocols);
  let stepped = 0;
  for (const row of board) {
    const entry = lookup.get(row.slug);
    if (entry !== undefined && scoreProtocol(entry, doc.as_of, params).implied !== row.implied_value_usd) stepped++;
  }
  return stepped;
}

/** One step as a single string: the action, then its cost and time, inside the gate's 20..600 characters. */
export function formatFarmStep(action: FarmAction): string {
  let line = `${action.text} Cost: ${action.cost}. Time: ${action.time}.`;
  if (line.length > 600) line = `${line.slice(0, 596)}...`;
  if (line.length < 20) line = `${line} Hold the position and check the protocol's own page.`;
  return line;
}

/** The first chain the protocol names, or a neutral phrase when it names none. */
function primaryChain(entry: ProtoEntry): string {
  return entry.chains.length > 0 ? entry.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, sized from the protocol's own TVL. */
function stakeFor(entry: ProtoEntry): number {
  const tvl = entry.tvl_usd;
  return tvl >= 5_000_000_000 ? 250 : tvl >= 1_000_000_000 ? 150 : tvl >= 100_000_000 ? 100 : 50;
}

/** How long to hold, from the protocol's age: younger protocols get the longer qualifying window. */
function holdingDays(age: number | null): number {
  if (age === null || age >= 365) return 30;
  return age < 180 ? 60 : 45;
}

/** What one transaction costs on the protocol's main chain, in a short phrase. */
function feeForChain(net: string): string {
  const fees: Record<string, string> = { Ethereum: 'about $8 of gas', Solana: 'under $0.10 of fees' };
  return fees[net] ?? 'about $1 of gas';
}

/** One category's farm wording: how to recognise the category, and the two texts it yields. */
interface CategoryRule {
  readonly test: (category: string) => boolean;
  readonly action: (stake: number, name: string, net: string) => string;
  readonly weekly: () => string;
}

/**
 * The category table, in the order the rules are tried: the first rule whose test matches the
 * protocol's lowercased category wins, and the last rule matches everything. The wording is the
 * same for every protocol in a category, filled in with that protocol's own stake, name and chain.
 */
const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    test: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'),
    action: (stake, name, net) => `Supply $${stake} of USDC to ${name} on ${net} as collateral and borrow $10 against it, then repay the loan the same week.`,
    weekly: () => 'Borrow $10 against the deposit and repay it in the same week, so the position shows both sides of the market.',
  },
  {
    test: (c) => c.includes('dex') || c.includes('liquidity'),
    action: (stake, name, net) => `Provide $${stake} of liquidity to ${name}'s main pool on ${net}, half USDC and half the chain's native asset, and keep the position open.`,
    weekly: () => 'Swap $5 through the pool and add the proceeds back as liquidity, so the position shows trading as well as providing.',
  },
  {
    test: (c) => c.includes('yield') || c.includes('leveraged farm') || c.includes('farm'),
    action: (stake, name, net) => `Deposit $${stake} of USDC into ${name}'s top vault on ${net} and let the yield compound in the vault.`,
    weekly: () => 'Claim the vault yield and compound it back into the same vault, so the balance grows every week.',
  },
  {
    test: (c) => c.includes('deriv') || c.includes('basis') || c.includes('perpetual') || c.includes('interest rate'),
    action: (stake, name, net) => `Deposit $${stake} of USDC as margin on ${name} on ${net} and open one small hedge, no larger than $25 of notional.`,
    weekly: () => 'Close the hedge and reopen it at the new price, so the margin account stays active without growing the risk.',
  },
  {
    test: (c) => c.includes('rwa') || c.includes('anchor') || c.includes('decentralized btc'),
    action: (stake, name, net) => `Mint $${stake} of ${name}'s yield-bearing asset on ${net} and hold it in the wallet you farm with.`,
    weekly: () => 'Check the yield accrual on the asset and mint $5 more of it, so the holding grows a little every week.',
  },
  {
    test: (c) => c.includes('curator') || c.includes('allocator'),
    action: (stake, name, net) => `Deposit $${stake} into a ${name} vault on ${net} and keep the vault shares for the whole farming window.`,
    weekly: () => 'Move $10 between the vault strategies, so the position shows active allocation rather than a single deposit.',
  },
  {
    test: (c) => c === 'chain',
    action: (stake, name, net) => `Bridge $${stake} of USDC to ${net} through its official bridge and use it in ${name}'s own app, not in a third-party pool.`,
    weekly: () => 'Send one transaction a week through the chain app itself, such as a transfer or a contract call from the farming wallet.',
  },
  {
    test: (c) => c.includes('staking') || c.includes('restak'),
    action: (stake, name, net) => `Stake $${stake} of the chain's staking asset through ${name} on ${net} and keep the staking receipt in the same wallet.`,
    weekly: () => 'Restake the staking rewards into the same position, so the staked balance grows every week.',
  },
  {
    test: (c) => c.includes('stable'),
    action: (stake, name, net) => `Mint or hold $${stake} of the stable asset through ${name} on ${net} and keep it in the wallet you farm with.`,
    weekly: () => 'Swap $5 of the stable asset in and out of the protocol, so the position shows use as well as holding.',
  },
  {
    test: (c) => c.includes('insurance'),
    action: (stake, name, net) => `Buy $${stake} of cover from ${name} on ${net} and keep the policy active for the whole farming window.`,
    weekly: () => 'Review the cover terms and the policy expiry, and renew it before it lapses so the cover never breaks.',
  },
  {
    test: (c) => c.includes('prediction'),
    action: (stake, name, net) => `Fund $${stake} and place one market position on ${name} on ${net}, staking on an outcome you have researched.`,
    weekly: () => 'Settle one small market position a week, so the account shows repeated participation.',
  },
  {
    test: (c) => c.includes('payment') || c.includes('card'),
    action: (stake, name, net) => `Load $${stake} onto ${name}'s card or app on ${net} and spend $5 through it to activate the account.`,
    weekly: () => 'Spend $5 through the card or app each week, so the account shows real use rather than a single load.',
  },
  {
    test: (c) => c.includes('index'),
    action: (stake, name, net) => `Buy $${stake} of ${name}'s index token on ${net} and hold it in the wallet you farm with.`,
    weekly: () => 'Buy $5 more of the index token each week, so the holding grows steadily instead of in one trade.',
  },
  {
    test: (c) => c.includes('governance'),
    action: (stake, name, net) => `Deposit $${stake} and cast one vote in ${name}'s governance on ${net} from the wallet you farm with.`,
    weekly: () => 'Vote on one new proposal a week, so the wallet shows repeated governance activity.',
  },
  {
    test: (c) => c.includes('cedefi'),
    action: (stake, name, net) => `Deposit $${stake} of USDC into ${name}'s CeDeFi vault on ${net} and keep the vault shares.`,
    weekly: () => 'Check the vault yield and compound $5 of it back into the vault each week.',
  },
  {
    test: () => true,
    action: (stake, name, net) => `Deposit $${stake} of USDC into ${name} on ${net} and keep the position open.`,
    weekly: () => 'Make one small deposit, swap or vote each week, so the position shows repeated activity.',
  },
];

/** One farm step, assembled from its action, cost and time. */
function farmStep(text: string, cost: string, time: string): FarmAction {
  return { text, cost, time };
}

/**
 * One protocol's farm plan: six steps, each an action with a cost and a time. The plan comes
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list
 * of names.
 */
export function buildFarmPlan(entry: ProtoEntry, age: number | null): FarmAction[] {
  const net = primaryChain(entry);
  const stake = stakeFor(entry);
  const window = holdingDays(age);
  const fee = feeForChain(net);
  const category = (entry.category ?? '').toLowerCase();
  const rule = CATEGORY_RULES.find((candidate) => candidate.test(category))!;
  const action = rule.action(stake, entry.name, net);
  const weekly = rule.weekly();
  const plan: FarmAction[] = [
    farmStep(
      `Open a fresh wallet on ${net} that holds only the $${stake} you plan to farm with ${entry.name}, and write its seed phrase on paper and keep it offline.`,
      `under $3 of gas for the first transaction on ${net}`,
      '5 minutes',
    ),
    farmStep(action, `$${stake} of capital and ${fee}`, '15 minutes to set up'),
    farmStep(weekly, `${fee} a week`, '10 minutes a week'),
    farmStep(
      `Hold the position for at least ${window} days so the activity is counted in more than one snapshot, and do not withdraw early.`,
      `the $${stake} stays in the position`,
      `${window} days`,
    ),
    farmStep(
      `Before you withdraw, open ${entry.name}'s own points or rewards page from the link the protocol itself publishes and check what the position earned.`,
      'no fee to check, and never pay to claim',
      '10 minutes',
    ),
    farmStep(
      `Write the wallet, the dates and every transaction hash in a farm log, then unwind in reverse: claim first, withdraw second, and keep $5 of gas on ${net} for the exit.`,
      'nothing but the log, plus exit gas',
      '10 minutes to unwind',
    ),
  ];
  return plan;
}

/** The live-token protocols, ordered by market cap, for the dashboard's Live token view. */
export function topLiveEntries(doc: SnapshotDoc): LiveEntry[] {
  return doc.protocols
    .filter((entry) => !hasNoToken(entry) && entry.category !== 'CEX')
    .sort((left, right) => (right.mcap_usd ?? 0) - (left.mcap_usd ?? 0) || right.tvl_usd - left.tvl_usd)
    .slice(0, LIVE_VIEW_COUNT)
    .map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      category: entry.category,
      chains: entry.chains,
      tvl_usd: entry.tvl_usd,
      mcap_usd: entry.mcap_usd,
      change_7d: entry.change_7d,
    }));
}

/** One board row in its compact form for data.js, with the farm plan exactly as board.json carries it. */
export function toRowView(ranked: RankedRow): RowView {
  const view: RowView = {
    rank: ranked.rank,
    slug: ranked.slug,
    name: ranked.name,
    category: ranked.category,
    chains: ranked.chains,
    tvl_usd: ranked.tvl_usd,
    change_7d: ranked.change_7d,
    mcap_usd: ranked.mcap_usd,
    listed_at: ranked.listed_at,
    age_days: ranked.age_days,
    implied_value_usd: ranked.implied_value_usd,
    base_value: ranked.model.base_value,
    growth_pct: ranked.model.growth_pct,
    growth_multiplier: ranked.model.growth_multiplier,
    maturity_multiplier: ranked.model.maturity_multiplier,
    farm_steps: ranked.farm_steps,
  };
  return view;
}

/** Everything the dashboard renders, built from the snapshot. */
export function scoreSnapshot(doc: SnapshotDoc, params: ModelParams = RADAR2_PARAMS): { board: RankedRow[]; radar: DashboardData } {
  const board = rankBoard(doc, params);
  const live = topLiveEntries(doc);
  const early = board.filter((row) => !doc.watchlist.includes(row.slug)).length;
  const radar: DashboardData = {
    as_of: doc.as_of, source: doc.source, floor_usd: doc.floor_usd,
    model: params, model_version: MODEL_LABEL,
    watchlist_size: doc.watchlist.length, board_size: board.length,
    early_size: early, live_size: live.length,
    adjusted_rows: countAdjustedRows(board, doc, params),
    rows: board.map(toRowView), live: live,
  };
  const result = { board, radar };
  return result;
}

/** A snapshot out of a file's text, refused unless it carries the shape the model scores. */
export function decodeSnapshot(text: string): SnapshotDoc {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new SnapshotProblem('snapshot.json is not JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SnapshotProblem('snapshot.json is not a JSON object');
  const doc = parsed as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) throw new SnapshotProblem('snapshot.json has no as_of date');
  if (typeof doc.source !== 'string') throw new SnapshotProblem('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) throw new SnapshotProblem('snapshot.json has no floor_usd');
  if (!Array.isArray(doc.protocols)) throw new SnapshotProblem('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((slug) => typeof slug !== 'string')) throw new SnapshotProblem('snapshot.json has no watchlist of slugs');
  const protocols = doc.protocols.map((value, position) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SnapshotProblem(`snapshot.json's protocol ${position} is not an object`);
    const entry = value as Record<string, unknown>;
    if (typeof entry.slug !== 'string' || typeof entry.name !== 'string' || typeof entry.tvl_usd !== 'number' || !Number.isFinite(entry.tvl_usd)) {
      throw new SnapshotProblem(`snapshot.json's protocol ${position} lacks a slug, a name or a TVL`);
    }
    const entryOut: ProtoEntry = {
      slug: entry.slug,
      name: entry.name,
      category: typeof entry.category === 'string' ? entry.category : null,
      chains: Array.isArray(entry.chains) ? entry.chains.filter((chain): chain is string => typeof chain === 'string') : [],
      tvl_usd: entry.tvl_usd,
      change_7d: typeof entry.change_7d === 'number' && Number.isFinite(entry.change_7d) ? entry.change_7d : null,
      listed_at: typeof entry.listed_at === 'string' ? entry.listed_at : null,
      gecko_id: typeof entry.gecko_id === 'string' ? entry.gecko_id : null,
      symbol: typeof entry.symbol === 'string' ? entry.symbol : null,
      mcap_usd: typeof entry.mcap_usd === 'number' && Number.isFinite(entry.mcap_usd) ? entry.mcap_usd : null,
    };
    return entryOut;
  });
  const snapshot: SnapshotDoc = {
    as_of: doc.as_of as string,
    source: doc.source as string,
    floor_usd: doc.floor_usd as number,
    protocols: protocols,
    watchlist: doc.watchlist as string[],
  };
  return snapshot;
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, a single shared implied value, and the farm steps. */
export function findBoardProblem(board: readonly RankedRow[], doc: SnapshotDoc): string | null {
  const slugs = new Set(board.map((row) => row.slug));
  const missing = doc.watchlist.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(', ');
    const plural = missing.length === 1 ? '' : 's';
    return `the board misses ${missing.length} watchlist slug${plural}: ${shown}`;
  }
  const ranks = board.map((row) => row.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2) {
    const first = board[0]!.implied_value_usd;
    const last = board[board.length - 1]!.implied_value_usd;
    if (first === last) {
      return `all ${board.length} rows share the same implied value $${first}: a board that ranks nothing by value is not a ranking`;
    }
  }
  for (const row of board) {
    const steps = row.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${row.slug} has ${steps.length} farm steps`;
    for (const step of steps) if (step.length < 20 || step.length > 600) return `${row.slug} has a farm step of ${step.length} characters`;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return `${row.slug} has implied value ${row.implied_value_usd}`;
  }
  return null; // the board passes every check
}

/** A compact data.js: the dashboard's whole dataset in one script, no fetch and no network. */
export function renderDataScript(data: DashboardData): string {
  return `window.RADAR=${JSON.stringify(data)};\n`;
}
