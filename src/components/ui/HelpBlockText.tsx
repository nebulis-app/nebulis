import type { ReactNode } from 'react';
import { blockFromText } from '../../lib/helpLead';

interface HelpBlock {
  headline: string;
  body?: string;
  tips?: string[];
}

export function HelpBlockText({ block, className }: { block: HelpBlock; className?: string }): ReactNode {
  return (
    <div className={className}>
      <p className="text-sm">
        <strong className="font-semibold">{block.headline}</strong>
        {block.body ? ` ${block.body}` : ''}
      </p>
      {block.tips?.length ? (
        <ul className="mt-1 list-disc pl-4 space-y-0.5 text-sm">
          {block.tips.map((tip, idx) => (
            <li key={idx}>{tip}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Renders `text` with its first sentence in bold when `blockFromText` finds one, else as-is. Returns inline
 * content, so the caller keeps its own `<p>`/`<div>` and body color. `leadClassName` lifts the lead one step
 * above that body color in both themes.
 */
export function ProseText({ text, leadClassName }: { text: string; leadClassName?: string }): ReactNode {
  const block = blockFromText(text);
  if (!block) return text;
  return (
    <>
      <strong className={`font-semibold ${leadClassName ?? ''}`}>{block.lead}</strong> {block.rest}
    </>
  );
}
