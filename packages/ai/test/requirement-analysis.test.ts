import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REQUIREMENT_ANALYSIS_OUTPUT_SCHEMA,
  REQUIREMENT_ANALYSIS_PROMPT_VERSION,
  StageOutputError,
  runRequirementAnalysisStage,
  type RequirementAnalysisInput,
} from '../src/index.js';
import { FakeModelProvider, fakeRequirementAnalysisOutput } from '../src/fake-provider.js';

const input: RequirementAnalysisInput = {
  demand: {
    id: '4a3f9c2e7b1d48f0a6c5e2d9b8f7a1c3',
    title: 'R-2041 取数逻辑',
    description: '按销售组织汇总开票金额',
    acceptanceCriteria: ['金额与 MARA 一致', '空结果返回 0'],
    requester: { userId: 'DEV001', orgUnit: 'PDO' },
    priority: 'normal',
  },
};

describe('requirement_analysis stage', () => {
  it('turns the deterministic fake output into a schema-valid stage result', async () => {
    const result = await runRequirementAnalysisStage(input, new FakeModelProvider());

    expect(REQUIREMENT_ANALYSIS_OUTPUT_SCHEMA.safeParse(result.output).success).toBe(true);
    expect(result.output.summary).toContain('R-2041 取数逻辑');
    expect(result.output.acceptanceCriteria).toHaveLength(2);
    expect(result.ledger).toMatchObject({
      promptVersion: REQUIREMENT_ANALYSIS_PROMPT_VERSION,
      attempt: 1,
      schemaOk: true,
      costUsd: 0,
    });
    expect(result.ledger.tokens).toBeGreaterThan(0);
    expect(result.ledger.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('tolerates a fenced ```json block in the model output', async () => {
    const text = fakeRequirementAnalysisOutput([
      { role: 'user', content: `<demand-json>${JSON.stringify(input.demand)}</demand-json>` },
    ]);
    const provider = new FakeModelProvider({ responses: ['```json\n' + text + '\n```'] });
    const result = await runRequirementAnalysisStage(input, provider);
    expect(result.output.summary).toContain('R-2041');
  });

  it('throws StageOutputError when the output is not JSON', async () => {
    const provider = new FakeModelProvider({ responses: ['not json at all'] });
    const failure = runRequirementAnalysisStage(input, provider);
    await expect(failure).rejects.toBeInstanceOf(StageOutputError);
    await expect(
      runRequirementAnalysisStage(input, new FakeModelProvider({ responses: ['not json at all'] })),
    ).rejects.toMatchObject({ rawText: 'not json at all' });
  });

  it('throws StageOutputError when the output violates the schema', async () => {
    const provider = new FakeModelProvider({
      responses: [JSON.stringify({ summary: 'missing everything else' })],
    });
    await expect(runRequirementAnalysisStage(input, provider)).rejects.toBeInstanceOf(
      StageOutputError,
    );
  });

  it('propagates a scripted provider error', async () => {
    const provider = new FakeModelProvider({ responses: [new Error('model exploded')] });
    await expect(runRequirementAnalysisStage(input, provider)).rejects.toThrow('model exploded');
  });

  it('ships the pinned prompt file', () => {
    const prompt = readFileSync(
      new URL('../prompts/requirement-analysis.md', import.meta.url),
      'utf8',
    );
    expect(prompt).toContain('{{demandJson}}');
    expect(prompt).toContain('{{promptVersion}}');
    expect(prompt).toContain('JSON');
  });
});
