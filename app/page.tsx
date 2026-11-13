import { redirect } from "next/navigation";

/** / opens the app; the dashboard sends anyone signed out to sign in. */
export default function Home() {
  redirect("/dashboard");
}
