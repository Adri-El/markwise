import { signOut } from "@/lib/actions/auth";

export default function SignOutButton() {
  return (
    <form action={signOut}>
      <button type="submit" className="text-sm underline">
        Sign out
      </button>
    </form>
  );
}
