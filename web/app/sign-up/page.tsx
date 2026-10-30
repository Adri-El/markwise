import AuthForm from "@/components/AuthForm";

export default function SignUpPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Create an account</h1>
      <AuthForm mode="sign-up" />
      <p className="text-sm">
        Already have an account?{" "}
        <a href="/sign-in" className="underline">
          Sign in
        </a>
      </p>
    </div>
  );
}
