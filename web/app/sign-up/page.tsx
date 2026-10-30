import AuthForm from "@/components/AuthForm";
import Card from "@/components/ui/Card";

export default function SignUpPage() {
  return (
    <div className="mx-auto max-w-md">
      <Card title="Create an account">
        <div className="space-y-4">
          <AuthForm mode="sign-up" />
          <p className="text-sm text-slate-600">
            Already have an account?{" "}
            <a
              href="/sign-in"
              className="font-medium text-indigo-600 hover:underline"
            >
              Sign in
            </a>
          </p>
        </div>
      </Card>
    </div>
  );
}
