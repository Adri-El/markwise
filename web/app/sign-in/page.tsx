import AuthForm from "@/components/AuthForm";
import Card from "@/components/ui/Card";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  return (
    <div className="mx-auto max-w-md">
      <Card title="Sign in">
        <div className="space-y-4">
          {notice === "check-email" && (
            <p className="text-sm text-slate-700">
              Account created. Check your email to confirm it, then sign in.
            </p>
          )}
          <AuthForm mode="sign-in" />
          <p className="text-sm text-slate-600">
            No account?{" "}
            <a
              href="/sign-up"
              className="font-medium text-indigo-600 hover:underline"
            >
              Sign up
            </a>
          </p>
        </div>
      </Card>
    </div>
  );
}
