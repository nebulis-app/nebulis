import type { ReactNode } from 'react';

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
