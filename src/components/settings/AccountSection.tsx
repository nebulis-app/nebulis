import { UsersSection } from './UsersSection';

/** Account = the people who can use this library. Wraps the existing UsersSection
 *  under the new section heading. When you flatten UsersSection to the row pattern,
 *  remove its internal heading so this wrapper's heading is the only one shown. */
export function AccountSection({ isDark }: { isDark: boolean }) {
  return (
    <div className="space-y-6">
      <UsersSection isDark={isDark} />
    </div>
  );
}
