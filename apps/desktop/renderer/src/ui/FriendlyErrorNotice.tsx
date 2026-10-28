import type { FriendlyError } from './friendly-errors';
import './pairing.css';

/** Title and next action in plain words; the original text stays one click away. */
export function FriendlyErrorNotice({ error }: { error: FriendlyError }) {
  return <span className="friendly-error">
    <strong>{error.title}</strong> <span>{error.action}</span>
    <details><summary>Details</summary><code>{error.details}</code></details>
  </span>;
}
