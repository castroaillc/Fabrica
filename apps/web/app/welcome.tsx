"use client";

import { Button, Column, Grid, Tile } from "@carbon/react";
import { ArrowRight, Dashboard, Rocket, Task } from "@carbon/react/icons";
import Link from "next/link";

const FEATURES = [
  {
    icon: Task,
    title: "Queue jobs",
    body: "Submit work to the factory and let it run in the background.",
  },
  {
    icon: Rocket,
    title: "Dispatch to runners",
    body: "Jobs are picked up by the runner service and executed in order.",
  },
  {
    icon: Dashboard,
    title: "Track everything",
    body: "See what's queued, running, finished or failed from one dashboard.",
  },
];

export function Welcome({ userName }: { userName: string | null }) {
  return (
    <main id="main-content" className="welcome">
      <Grid className="welcome__hero">
        <Column sm={4} md={8} lg={10}>
          <p className="welcome__eyebrow">{userName ? `Welcome back, ${userName}` : "Welcome to Factory"}</p>
          <h1 className="welcome__title">Build, run and monitor your jobs in one place.</h1>
          <p className="welcome__lede">
            Factory queues your work, hands it to runners and keeps you posted on every step.
          </p>
          <div className="welcome__actions">
            {userName ? (
              <Button as={Link} href="/dashboard" renderIcon={ArrowRight}>
                Go to dashboard
              </Button>
            ) : (
              <>
                <Button as={Link} href="/sign-in" renderIcon={ArrowRight}>
                  Get started
                </Button>
                <Button as={Link} href="/sign-in" kind="tertiary">
                  Sign in
                </Button>
              </>
            )}
          </div>
        </Column>
      </Grid>
      <Grid className="welcome__features">
        {FEATURES.map(({ icon: Icon, title, body }) => (
          <Column key={title} sm={4} md={4} lg={5}>
            <Tile className="welcome__feature">
              <Icon size={32} className="welcome__feature-icon" />
              <h2 className="cds--type-productive-heading-03">{title}</h2>
              <p className="cds--type-body-long-01">{body}</p>
            </Tile>
          </Column>
        ))}
      </Grid>
    </main>
  );
}
