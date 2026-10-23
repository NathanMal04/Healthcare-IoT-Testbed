// Small pieces shared by the sign-in screens (login, signup, confirm, forgot
// password). The frame around them is app/(auth)/layout.tsx.

export function AuthHeading({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">{title}</h1>
      {description && <p className="text-sm text-slate-500 mt-1.5">{description}</p>}
    </div>
  );
}

/** The user pool's password policy, shown wherever a password is chosen. */
export const PASSWORD_HINT = "At least 8 characters, with an uppercase letter, a lowercase letter and a number.";
