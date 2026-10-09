import { describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@model-runtime/core";
import { OpenAiResponsesProvider } from "@model-runtime/provider-openai";
import { AnthropicMessagesProvider } from "@model-runtime/provider-anthropic";
import { FalQueueProvider } from "@model-runtime/provider-fal";
import type { ExecutionRequest, RuntimeEvent } from "@model-runtime/protocol";

const adapters = [OpenAiResponsesProvider, AnthropicMessagesProvider];
const request: ExecutionRequest = {
  ability: "text-generation",
  input: [{ type: "text", text: "synthetic fixture" }],
};

describe("model-specific adapter capability declarations", () => {
  it.each(adapters)("uses conservative text defaults for %s", async (Adapter) => {
    const provider = new Adapter({ model: "model-alpha", apiKey: "fixture-credential" });
    expect((await provider.manifest()).models[0]).toMatchObject({
      input_modalities: ["text", "json"],
      output_modalities: ["text"],
      tools: false,
      structured_output: false,
      stream: true,
    });
  });

  it.each(adapters)(
    "rejects undeclared capabilities before credentials or HTTP for %s",
    async (Adapter) => {
      const fetch = vi.fn();
      const apiKey = vi.fn(() => "fixture-credential");
      const runtime = new ModelRuntime();
      runtime.register(new Adapter({ model: "model-alpha", apiKey, fetch }));
      for (const value of [
        {
          ...request,
          input: [{ type: "image" as const, uri: "https://media.example.test/input.png" }],
        },
        { ...request, requirements: { tools: true } },
        { ...request, requirements: { structured_output: true } },
        { ...request, requirements: { output_modalities: ["json" as const] } },
      ]) {
        const events: RuntimeEvent[] = [];
        for await (const event of runtime.execute(value)) events.push(event);
        expect(events.at(-1)).toMatchObject({
          type: "execution.failed",
          error: { code: "capability_unavailable" },
        });
        expect(events.some((event) => event.type === "route.selected")).toBe(false);
      }
      expect(apiKey).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      await runtime.close();
    },
  );

  it.each(adapters)(
    "copies configured capabilities and returned manifests for %s",
    async (Adapter) => {
      const capabilities = { input_modalities: ["text" as const, "image" as const], tools: true };
      const abilities = ["text-generation"];
      const provider = new Adapter({
        model: "model-alpha",
        apiKey: "fixture-credential",
        capabilities,
        abilities,
      });
      capabilities.input_modalities.splice(0);
      capabilities.tools = false;
      abilities.splice(0);
      const manifest = await provider.manifest();
      manifest.models[0]!.input_modalities.splice(0);
      manifest.models[0]!.abilities.splice(0);
      manifest.models[0]!.tools = false;
      expect((await provider.manifest()).models[0]).toMatchObject({
        input_modalities: ["text", "image"],
        abilities: ["text-generation"],
        tools: true,
      });
    },
  );

  it.each(adapters)(
    "blocks tools hidden in extensions even for direct SPI calls for %s",
    async (Adapter) => {
      const fetch = vi.fn();
      const provider = new Adapter({ model: "model-alpha", apiKey: "fixture-credential", fetch });
      const namespace = Adapter === OpenAiResponsesProvider ? "openai" : "anthropic";
      const execution = provider.execute({
        executionId: "synthetic",
        target: { provider: provider.id, model: "model-alpha" },
        signal: new AbortController().signal,
        request: { ...request, extensions: { [namespace]: { request: { tools: [] } } } },
      });
      await expect(execution[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: "capability_unavailable",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects declarations outside adapter translation support", () => {
    expect(
      () =>
        new AnthropicMessagesProvider({
          model: "model-alpha",
          apiKey: "fixture-credential",
          capabilities: { input_modalities: ["file"] },
        }),
    ).toThrow("modality declaration");
    expect(
      () =>
        new OpenAiResponsesProvider({
          model: "model-alpha",
          apiKey: "fixture-credential",
          capabilities: { input_modalities: ["audio"] },
        }),
    ).toThrow("modality declaration");
    expect(
      () =>
        new OpenAiResponsesProvider({
          model: "model-alpha",
          apiKey: "fixture-credential",
          capabilities: { input_modalities: ["text", "text"] },
        }),
    ).toThrow("modality declaration");
    expect(
      () =>
        new OpenAiResponsesProvider({
          model: "model-alpha",
          apiKey: "fixture-credential",
          capabilities: { input_modalities: [] },
        }),
    ).toThrow("modality declaration");
  });

  it("does not guess fal model modalities from provider or ability", async () => {
    const options = {
      model: "models/alpha",
      ability: "media-generation",
      apiKey: "fixture-credential",
    };
    const provider = new FalQueueProvider(options);
    expect((await provider.manifest()).models[0]).toMatchObject({
      input_modalities: ["text", "json"],
      output_modalities: ["json"],
    });
    const inputs = ["image" as const];
    const outputs = ["video" as const];
    const configured = new FalQueueProvider({
      ...options,
      inputModalities: inputs,
      outputModalities: outputs,
    });
    inputs.splice(0);
    outputs.splice(0);
    expect((await configured.manifest()).models[0]).toMatchObject({
      input_modalities: ["image"],
      output_modalities: ["video"],
    });
    expect(() => new FalQueueProvider({ ...options, inputModalities: ["audio"] })).toThrow(
      "modality declaration",
    );
  });

  it.each(adapters)("translates explicitly enabled image input for %s", async (Adapter) => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (Adapter === OpenAiResponsesProvider) {
        expect(body.input[0].content[0]).toMatchObject({
          type: "input_image",
          image_url: "https://media.example.test/input.png",
        });
        return new Response('data: {"type":"response.completed","response":{}}\n\n');
      }
      expect(body.messages[0].content[0]).toMatchObject({
        type: "image",
        source: { type: "url", url: "https://media.example.test/input.png" },
      });
      return new Response('data: {"type":"message_stop"}\n\n');
    });
    const runtime = new ModelRuntime();
    runtime.register(
      new Adapter({
        model: "model-alpha",
        apiKey: "fixture-credential",
        capabilities: { input_modalities: ["image"] },
        fetch,
      }),
    );
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.execute({
      ...request,
      input: [{ type: "image", uri: "https://media.example.test/input.png" }],
    }))
      events.push(event);
    expect(events.at(-1)?.type).toBe("execution.completed");
    expect(fetch).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("rejects undeclared fal image inputs before HTTP", async () => {
    const fetch = vi.fn();
    const runtime = new ModelRuntime();
    runtime.register(
      new FalQueueProvider({
        model: "models/alpha",
        ability: "image-generation",
        apiKey: "fixture-credential",
        fetch,
      }),
    );
    const events: RuntimeEvent[] = [];
    for await (const event of runtime.execute({
      ability: "image-generation",
      input: [{ type: "image", uri: "https://media.example.test/input.png" }],
    }))
      events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "execution.failed",
      error: { code: "capability_unavailable" },
    });
    expect(fetch).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("preserves fal JSON input as prompt text without dropping null or scalars", async () => {
    const fetch = vi.fn(
      async (_url: unknown, _init?: RequestInit) => new Response("{}", { status: 400 }),
    );
    const runtime = new ModelRuntime();
    runtime.register(
      new FalQueueProvider({
        model: "models/alpha",
        ability: "image-generation",
        apiKey: "fixture-credential",
        fetch,
      }),
    );
    for await (const _event of runtime.execute({
      ability: "image-generation",
      input: [
        { type: "text", text: "fixture" },
        { type: "json", value: { topic: "synthetic" } },
        { type: "json", value: null },
        { type: "json", value: false },
        { type: "json", value: 0 },
      ],
    })) {
      // The rejected submission keeps this mapping test independent of polling.
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      prompt: 'fixture\n{"topic":"synthetic"}\nnull\nfalse\n0',
    });
    await runtime.close();
  });
});
