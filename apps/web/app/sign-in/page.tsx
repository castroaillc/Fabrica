"use client";

import { Button, Form, InlineNotification, PasswordInput, Stack, TextInput, Toggle } from "@carbon/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export default function SignInPage() {
  const router = useRouter();
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email"));
    const password = String(data.get("password"));

    setPending(true);
    setError(null);
    const { error } = isSignUp
      ? await authClient.signUp.email({ email, password, name: String(data.get("name")) })
      : await authClient.signIn.email({ email, password });
    setPending(false);

    if (error) {
      setError(error.message ?? "Something went wrong");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="narrow-page">
      <Form onSubmit={onSubmit}>
        <Stack gap={6}>
          <h1 className="cds--type-productive-heading-05">{isSignUp ? "Create account" : "Sign in"}</h1>
          {error && <InlineNotification kind="error" title="Error" subtitle={error} hideCloseButton />}
          {isSignUp && <TextInput id="name" name="name" labelText="Name" required />}
          <TextInput id="email" name="email" type="email" labelText="Email" required />
          <PasswordInput id="password" name="password" labelText="Password" minLength={8} required />
          <Toggle
            id="mode"
            labelText="New here?"
            labelA="Sign in"
            labelB="Sign up"
            toggled={isSignUp}
            onToggle={setIsSignUp}
          />
          <Button type="submit" disabled={pending}>
            {isSignUp ? "Sign up" : "Sign in"}
          </Button>
        </Stack>
      </Form>
    </main>
  );
}
