import { Clock } from 'lucide-react';
import { Icon } from '../components/Icon';

/** Placeholder for every feature scheduled for a later phase. */
export function ComingLater({ message }: { message: string }) {
  return (
    <div className="coming-later">
      <Icon of={Clock} size={28} />
      <p>{message}</p>
    </div>
  );
}
