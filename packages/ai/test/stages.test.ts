import { describe, expect, it } from 'vitest';
import {
  AI_STAGE_DEFINITIONS,
  FakeModelProvider,
  StageOutputError,
  aiStageDefinition,
  renderAiStagePrompt,
  requireAiStageDefinition,
  resetPromptCache,
  runAiStage,
  type AiStageInput,
} from '../src/index.js';

const input: AiStageInput = {
  stageKey: 'intake',
  stageName: '受理与澄清',
  promptVersion: 'intake/v1',
  demand: {
    id: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
    title: 'R-2041 取数逻辑',
    description: '按销售组织汇总开票金额',
    acceptanceCriteria: ['金额与 MARA 一致', '空结果返回 0'],
    requester: { userId: 'REQ001', orgUnit: 'PDO' },
    priority: 'normal',
  },
  upstream: [
    {
      kind: 'free_note',
      artifactId: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q',
      version: 1,
      contentType: 'application/json',
      contentText: '{"summary":"已受理"}',
    },
  ],
};

describe('server-AI stage registry (H1 §1.1, docs/003 §6)', () => {
  it('registers the five H1 server-AI stages', () => {
    expect(Object.keys(AI_STAGE_DEFINITIONS).sort()).toEqual([
      'dev_spec',
      'intake',
      'knowledge_entry',
      'requirement_analysis',
      'test_doc',
    ]);
    expect(requireAiStageDefinition('dev_spec').outputArtifactKind).toBe('dev_spec');
    expect(aiStageDefinition('missing')).toBeUndefined();
    expect(() => requireAiStageDefinition('missing')).toThrow(/no server-AI stage/);
  });

  it('renders the prompt with demand, upstream artifacts and the pinned version', () => {
    resetPromptCache();
    const definition = requireAiStageDefinition('dev_spec');
    const prompt = renderAiStagePrompt(definition, {
      ...input,
      stageKey: 'dev_spec',
      stageName: '开发说明',
      promptVersion: definition.promptVersion,
    });
    expect(prompt).toContain('dev-spec/v1');
    expect(prompt).toContain('R-2041 取数逻辑');
    expect(prompt).toContain('01J8ZQ9W3K5M2V7X4C6B8N0P1Q');
    expect(prompt).toContain('<demand-json>');
  });

  it.each(['intake', 'requirement_analysis', 'dev_spec', 'test_doc', 'knowledge_entry'])(
    'runs the %s stage against the fake provider and records the ledger',
    async (stageKey) => {
      const definition = requireAiStageDefinition(stageKey);
      const result = await runAiStage(
        definition,
        { ...input, stageKey, stageName: definition.name, promptVersion: definition.promptVersion },
        new FakeModelProvider(),
        { attempt: 2 },
      );
      expect(result.ledger).toMatchObject({
        promptVersion: definition.promptVersion,
        attempt: 2,
        schemaOk: true,
      });
      expect(result.ledger.tokens).toBeGreaterThan(0);
      expect(result.output).toBeTypeOf('object');
    },
  );

  it('fails with StageOutputError instead of returning a half-baked output', async () => {
    const definition = requireAiStageDefinition('dev_spec');
    const provider = new FakeModelProvider({ responses: ['not json'] });
    await expect(
      runAiStage(definition, { ...input, stageKey: 'dev_spec' }, provider),
    ).rejects.toBeInstanceOf(StageOutputError);
  });

  it('rejects schema-invalid output while keeping the raw text on the error', async () => {
    const definition = requireAiStageDefinition('test_doc');
    const provider = new FakeModelProvider({ responses: ['{"summary":"x"}'] });
    await expect(
      runAiStage(definition, { ...input, stageKey: 'test_doc' }, provider),
    ).rejects.toMatchObject({ name: 'StageOutputError', rawText: '{"summary":"x"}' });
  });
});
