import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DEFAULT_RUNNER_URL, SAMPLE_JOBS } from "@/lib/sample-jobs";
import { DashboardView } from "./dashboard-view";

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  return (
    <DashboardView
      user={{ name: session.user.name, email: session.user.email }}
      jobs={SAMPLE_JOBS}
      runnerUrl={DEFAULT_RUNNER_URL}
    />
  );
}
