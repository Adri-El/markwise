import AuthForm from "@/components/AuthForm";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Sign in</h1>
      {notice === "check-email" && (
        <p className="text-sm text-neutral-700">
          Account created. Check your email to confirm it, then sign in.
        </p>
      )}
      <AuthForm mode="sign-in" />
      <p className="text-sm">
        No account?{" "}
        <a href="/sign-up" className="underline">
          Sign up
        </a>
      </p>
    </div>
  );
}
