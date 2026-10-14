import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { SiteHeader } from "@/components/site-header";
import { Welcome } from "./welcome";

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <>
      <SiteHeader />
      <Welcome userName={session?.user.name ?? null} />
    </>
  );
}
