// #5876: one-shot post-upgrade notice for the auto_chronicle default flip. Printed by
// `gbrain post-upgrade` while the operator has not answered the change (key unset, or an explicit
// `true` written before this release, when it had no effect). The doctor/advisor
// `auto_chronicle_default_on` notice stays visible after this prints, until the key is set.
import type { BrainEngine } from '../engine.ts';
import {
  AUTO_CHRONICLE_KEEP_ARGV, AUTO_CHRONICLE_OPT_OUT_ARGV, CHRONICLE_NOTICE_SHOWN_KEY, autoChronicleNeedsAcknowledgement,
  chronicleSettings,
} from './config.ts';
import { CHRONICLE_RUN_NOW_ARGV, chronicleBackfillArgv } from './reasons.ts';

export interface ChronicleProviderView {
  /** Configured chat model id, or null when it cannot be resolved. */
  model: string | null;
  priced: boolean;
  chatAvailable: boolean;
}

async function providerView(engine: BrainEngine): Promise<ChronicleProviderView> {
  try {
    const { configureGatewayIfUninitialized, getChatModel, isAvailable } = await import('../ai/gateway.ts');
    const { isModelPriceable, loadPricingOverrides } = await import('../budget/budget-tracker.ts');
    // post-upgrade opens its engine without cli.ts's connect path, so the gateway may be unconfigured.
    configureGatewayIfUninitialized();
    const model = getChatModel();
    return { model, priced: isModelPriceable(model, 'chat', await loadPricingOverrides(engine)), chatAvailable: isAvailable('chat') };
  } catch {
    return { model: null, priced: false, chatAvailable: false };
  }
}

/** The notice lines, or null when it must not print (already shown, opted out, or acknowledged). */
export async function autoChronicleUpgradeNotice(engine: BrainEngine, view?: ChronicleProviderView): Promise<string[] | null> {
  const shown = await engine.getConfig(CHRONICLE_NOTICE_SHOWN_KEY);
  if (shown != null && shown.trim() !== '') return null;
  if (!(await autoChronicleNeedsAcknowledgement(engine))) return null;
  const settings = await chronicleSettings(engine);
  const provider = view ?? await providerView(engine);
  const ceiling = settings.dailyLimit * settings.jobBudgetUsd;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const runs = `On this ${engine.kind === 'pglite' ? 'PGLite' : 'Postgres'} brain, pending pages run in the autopilot cycle; ` +
    `\`${CHRONICLE_RUN_NOW_ARGV.join(' ')}\` runs them now.`;
  const cost = provider.priced
    ? `Worst case: ${settings.dailyLimit} calls/day x $${settings.jobBudgetUsd.toFixed(2)} per-page cap = $${ceiling.toFixed(2)}/day with ${provider.model}. ` +
      'The cap is per page, not a daily budget; typical pages cost far less.'
    : `gbrain has no price for ${provider.model ?? 'the configured chat model'}, so the per-page cap ($${settings.jobBudgetUsd.toFixed(2)}) cannot apply: ` +
      `calls are unbounded in dollars (still at most ${settings.dailyLimit} per day).`;
  return [
    '',
    '═══════════════════════════════════════════════════════════════',
    '[gbrain] Automatic event extraction (auto_chronicle) is now ON by default.',
    '[gbrain] Each new or changed meeting, conversation or calendar page gets one',
    '[gbrain] paid chat call that turns it into timeline events (life/events/).',
    '═══════════════════════════════════════════════════════════════',
    `[AGENT] Relay this to the user: it spends money and sends page text to the configured chat provider${provider.model ? ` (${provider.model})` : ''}.`,
    `[AGENT] ${cost}`,
    `[AGENT] Only pages written after this upgrade, dated within ${settings.recentDays} days, run automatically; history is not swept.`,
    `[AGENT] ${runs}`,
    ...(provider.chatAvailable ? [] : ['[AGENT] No chat provider is configured, so nothing runs until the user sets one up.']),
    `[AGENT] Keep it (records the user's answer): ${AUTO_CHRONICLE_KEEP_ARGV.join(' ')}`,
    `[AGENT] Opt out: ${AUTO_CHRONICLE_OPT_OUT_ARGV.join(' ')}`,
    `[AGENT] History is paid too; ask before running it. Preview: ${chronicleBackfillArgv({ since, dryRun: true }).join(' ')}`,
    '[AGENT] Guide: docs/guides/life-chronicle.md',
    '',
  ];
}

/** Prints the notice once and stamps it. Best-effort: never blocks the upgrade. */
export async function printAutoChronicleUpgradeNotice(engine: BrainEngine, log: (line: string) => void = console.log): Promise<boolean> {
  try {
    const lines = await autoChronicleUpgradeNotice(engine);
    if (!lines) return false;
    for (const line of lines) log(line);
    await engine.setConfig(CHRONICLE_NOTICE_SHOWN_KEY, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}
