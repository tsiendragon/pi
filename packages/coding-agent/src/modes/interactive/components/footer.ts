import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextUsage: ContextUsage | undefined;
}

export interface FooterViewModel {
	readonly pwd: string;
	readonly statsLeft: string;
	readonly modelName: string;
	readonly provider?: string;
	readonly availableProviderCount?: number;
	readonly reasoning?: boolean;
	readonly thinkingLevel?: string;
	/** Routed model suffix shown after the model name, for example "claude-sonnet-4 • high". */
	readonly routedLabel?: string;
	readonly extensionStatuses?: ReadonlyMap<string, string>;
}

export function renderFooterViewModel(model: FooterViewModel, width: number): string[] {
	let statsLeft = model.statsLeft;
	let statsLeftWidth = visibleWidth(statsLeft);
	if (statsLeftWidth > width) {
		statsLeft = truncateToWidth(statsLeft, width, "...");
		statsLeftWidth = visibleWidth(statsLeft);
	}

	const minPadding = 2;
	let rightSideWithoutProvider = model.modelName;
	if (model.reasoning) {
		const thinkingLevel = model.thinkingLevel || "off";
		rightSideWithoutProvider =
			thinkingLevel === "off" ? `${model.modelName} • thinking off` : `${model.modelName} • ${thinkingLevel}`;
	}
	if (model.routedLabel) {
		rightSideWithoutProvider += ` → ${model.routedLabel}`;
	}

	let rightSide = rightSideWithoutProvider;
	if ((model.availableProviderCount ?? 0) > 1 && model.provider) {
		rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
		if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
			rightSide = rightSideWithoutProvider;
		}
	}

	const rightSideWidth = visibleWidth(rightSide);
	const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
	let statsLine: string;
	if (totalNeeded <= width) {
		statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
	} else {
		const availableForRight = width - statsLeftWidth - minPadding;
		if (availableForRight > 0) {
			const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
			const truncatedRightWidth = visibleWidth(truncatedRight);
			statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth)) + truncatedRight;
		} else {
			statsLine = statsLeft;
		}
	}

	const dimStatsLeft = theme.fg("dim", statsLeft);
	const remainder = statsLine.slice(statsLeft.length);
	const dimRemainder = theme.fg("dim", remainder);
	const lines = [
		truncateToWidth(theme.fg("dim", model.pwd), width, theme.fg("dim", "...")),
		dimStatsLeft + dimRemainder,
	];
	if (model.extensionStatuses && model.extensionStatuses.size > 0) {
		const statusLine = Array.from(model.extensionStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.join(" ");
		lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
	}
	return lines;
}

export class FooterViewModelComponent implements Component {
	private model: FooterViewModel;

	constructor(model: FooterViewModel) {
		this.model = model;
	}

	setModel(model: FooterViewModel): void {
		this.model = model;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return renderFooterViewModel(this.model, width);
	}
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private sessionStats?: SessionStats;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			latestCacheHitRate,
			contextUsage,
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const { usageTotals, latestCacheHitRate, contextUsage } = this.getSessionStats();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line
		const statsParts = [];
		if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
		if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
		if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
		if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (usageTotals.cost || usingSubscription) {
			const costStr = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		const routed = this.session.routedModel;
		const routedLabel = routed
			? `${routed.model.id}${routed.thinkingLevel ? ` • ${routed.thinkingLevel}` : ""}`
			: undefined;

		return renderFooterViewModel(
			{
				pwd,
				statsLeft: statsParts.join(" "),
				modelName: state.model?.id || "no-model",
				...(state.model ? { provider: state.model.provider } : {}),
				availableProviderCount: this.footerData.getAvailableProviderCount(),
				reasoning: state.model?.reasoning ?? false,
				...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
				...(routedLabel ? { routedLabel } : {}),
				extensionStatuses: this.footerData.getExtensionStatuses(),
			},
			width,
		);
	}
}
