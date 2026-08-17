import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBashTool } from "../src/core/tools/bash.ts";

describe("AgentSession dynamic tool registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exposes session state before custom bash spawn hooks and supports opting out", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.create(tempDir, join(agentDir, "sessions"), { id: "bash-env-test" });
		let sessionEnv: NodeJS.ProcessEnv | undefined;
		let optedOutEnv: NodeJS.ProcessEnv | undefined;
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						createBashTool(tempDir, {
							spawnHook: (ctx) => {
								sessionEnv = ctx.env;
								return ctx;
							},
						}),
					);
					pi.registerTool({
						...createBashTool(tempDir, {
							exposeSessionEnvironment: false,
							spawnHook: (ctx) => {
								optedOutEnv = ctx.env;
								return ctx;
							},
						}),
						name: "bash_without_session_env",
						label: "bash without session env",
					});
				},
			],
		});
		await resourceLoader.reload();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			thinkingLevel: "high",
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		expect(session.systemPrompt).toContain(
			"You can inspect PI_* environment variables for current model and session details.",
		);
		await bashTool.execute("bash-env", { command: "printf ok" });
		expect(sessionEnv).toMatchObject({
			PI_SESSION_ID: session.sessionId,
			PI_SESSION_FILE: session.sessionFile,
			PI_PROVIDER: model.provider,
			PI_MODEL: model.id,
			PI_REASONING_LEVEL: session.thinkingLevel,
		});

		const optedOutBashTool = session.agent.state.tools.find((tool) => tool.name === "bash_without_session_env")!;
		await optedOutBashTool.execute("bash-no-env", { command: "printf ok" });
		expect(optedOutEnv).not.toHaveProperty("PI_SESSION_ID");
		expect(optedOutEnv).not.toHaveProperty("PI_SESSION_FILE");
		expect(optedOutEnv).not.toHaveProperty("PI_PROVIDER");
		expect(optedOutEnv).not.toHaveProperty("PI_MODEL");
		expect(optedOutEnv).not.toHaveProperty("PI_REASONING_LEVEL");

		session.dispose();
	});

	it("executes active tools through validation, policy hooks, updates, and lifecycle events", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		let extensionApi!: ExtensionAPI;
		let executions = 0;
		let activeExecutions = 0;
		let maxActiveExecutions = 0;
		let activePreflights = 0;
		let maxActivePreflights = 0;
		let activeSequentialExecutions = 0;
		let maxActiveSequentialExecutions = 0;
		const events: string[] = [];
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.registerTool({
						name: "nested_sequential_target",
						label: "Nested Sequential Target",
						description: "Sequential nested execution target",
						parameters: Type.Object({ value: Type.Number() }),
						executionMode: "sequential",
						execute: async (_toolCallId, params) => {
							activeSequentialExecutions++;
							maxActiveSequentialExecutions = Math.max(
								maxActiveSequentialExecutions,
								activeSequentialExecutions,
							);
							await new Promise((resolve) => setTimeout(resolve, 10));
							activeSequentialExecutions--;
							return { content: [{ type: "text", text: `sequential:${params.value}` }], details: {} };
						},
					});
					pi.registerTool({
						name: "nested_target",
						label: "Nested Target",
						description: "Nested execution target",
						parameters: Type.Object({ value: Type.Number() }),
						execute: async (_toolCallId, params, _signal, onUpdate) => {
							executions++;
							activeExecutions++;
							maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
							onUpdate?.({ content: [{ type: "text", text: "working" }], details: {} });
							await new Promise((resolve) => setTimeout(resolve, 10));
							activeExecutions--;
							return { content: [{ type: "text", text: `value:${params.value}` }], details: {} };
						},
					});
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "nested_target") return;
						activePreflights++;
						maxActivePreflights = Math.max(maxActivePreflights, activePreflights);
						events.push("tool_call");
						await new Promise((resolve) => setTimeout(resolve, 5));
						activePreflights--;
						if (event.input.value === 9) return { block: true, reason: "blocked by test policy" };
					});
					pi.on("tool_result", (event) => {
						if (event.toolName === "nested_target") events.push("tool_result");
					});
					pi.on("tool_execution_start", (event) => {
						if (event.toolName === "nested_target") events.push("start");
					});
					pi.on("tool_execution_update", (event) => {
						if (event.toolName === "nested_target") events.push("update");
					});
					pi.on("tool_execution_end", (event) => {
						if (event.toolName === "nested_target") events.push("end");
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		const updates: string[] = [];
		const executed = await extensionApi.executeTool(
			"nested_target",
			{ value: 3 },
			{
				toolCallId: "nested-1",
				onUpdate: (partial) => updates.push((partial.content[0] as { text: string }).text),
			},
		);
		expect(executed).toMatchObject({
			isError: false,
			result: { content: [{ type: "text", text: "value:3" }] },
		});
		expect(updates).toEqual(["working"]);
		expect(events).toEqual(["start", "tool_call", "update", "tool_result", "end"]);

		const invalid = await extensionApi.executeTool("nested_target", { value: "bad" });
		expect(invalid.isError).toBe(true);
		expect(executions).toBe(1);

		const blocked = await extensionApi.executeTool("nested_target", { value: 9 });
		expect(blocked.isError).toBe(true);
		expect(blocked.result.content[0]).toMatchObject({ text: "blocked by test policy" });
		expect(executions).toBe(1);

		await Promise.all([
			extensionApi.executeTool("nested_target", { value: 4 }),
			extensionApi.executeTool("nested_target", { value: 5 }),
		]);
		expect(maxActivePreflights).toBe(1);
		expect(maxActiveExecutions).toBe(2);

		await Promise.all([
			extensionApi.executeTool("nested_sequential_target", { value: 6 }),
			extensionApi.executeTool("nested_sequential_target", { value: 7 }),
		]);
		expect(maxActiveSequentialExecutions).toBe(1);

		session.setActiveToolsByName(["read"]);
		await expect(extensionApi.executeTool("nested_target", { value: 4 })).rejects.toThrow(
			"Tool nested_target is not active",
		);
		session.dispose();
	});

	it("refreshes tool registry when tools are registered after initialization", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							promptGuidelines: ["Use dynamic_tool when the user asks for dynamic behavior tests."],
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("dynamic_tool");

		await session.bindExtensions({});

		const allTools = session.getAllTools();
		const dynamicTool = allTools.find((tool) => tool.name === "dynamic_tool");
		const readTool = allTools.find((tool) => tool.name === "read");

		expect(allTools.map((tool) => tool.name)).toContain("dynamic_tool");
		expect(dynamicTool?.promptGuidelines).toEqual([
			"Use dynamic_tool when the user asks for dynamic behavior tests.",
		]);
		expect(dynamicTool?.sourceInfo).toMatchObject({
			path: "<inline:1>",
			source: "inline",
			scope: "temporary",
			origin: "top-level",
		});
		expect(readTool?.sourceInfo).toMatchObject({
			path: "builtin:read",
			source: "builtin",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("dynamic_tool");
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).toContain("- Use dynamic_tool when the user asks for dynamic behavior tests.");

		session.dispose();
	});

	it("returns source metadata for SDK custom tools", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			customTools: [
				{
					name: "sdk_tool",
					label: "SDK Tool",
					description: "Tool registered through createAgentSession",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				},
			],
		});

		const sdkTool = session.getAllTools().find((tool) => tool.name === "sdk_tool");
		expect(sdkTool?.sourceInfo).toMatchObject({
			path: "<sdk:sdk_tool>",
			source: "sdk",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("sdk_tool");

		session.dispose();
	});

	it("keeps custom tools active but omits them from available tools when promptSnippet is not provided", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "hidden_tool",
							label: "Hidden Tool",
							description: "Description should not appear in available tools",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toContain("hidden_tool");
		expect(session.getActiveToolNames()).toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("Description should not appear in available tools");

		session.dispose();
	});
});
