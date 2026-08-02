import { UsersSection } from './UsersSection';

/** Account = the people who can use this library. */
export function AccountSection({ isDark }: { isDark: boolean }) {
  return (
    <div className="space-y-6">
      <UsersSection isDark={isDark} />
    </div>
  );
}
