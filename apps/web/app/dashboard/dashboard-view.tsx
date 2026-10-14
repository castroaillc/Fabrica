"use client";

import {
  Column,
  Content,
  Grid,
  Header,
  HeaderContainer,
  HeaderGlobalBar,
  HeaderMenuButton,
  HeaderName,
  SideNav,
  SideNavItems,
  SideNavLink,
  SkipToContent,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Tile,
} from "@carbon/react";
import { Dashboard, Home, Task } from "@carbon/react/icons";
import type { Job, JobStatus } from "@/lib/sample-jobs";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "../sign-out-button";

const STATUS_TAG: Record<JobStatus, { label: string; type: "gray" | "blue" | "green" | "red" }> = {
  queued: { label: "Queued", type: "gray" },
  running: { label: "Running", type: "blue" },
  succeeded: { label: "Succeeded", type: "green" },
  failed: { label: "Failed", type: "red" },
};

const STATUSES = Object.keys(STATUS_TAG) as JobStatus[];

const timeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

interface DashboardViewProps {
  user: { name: string; email: string };
  jobs: Job[];
  runnerUrl: string;
}

export function DashboardView({ user, jobs, runnerUrl }: DashboardViewProps) {
  return (
    <>
      <HeaderContainer
        render={({ isSideNavExpanded, onClickSideNavExpand }) => (
          <Header aria-label="Factory">
            <SkipToContent />
            <HeaderMenuButton
              aria-label={isSideNavExpanded ? "Close menu" : "Open menu"}
              isActive={isSideNavExpanded}
              aria-expanded={isSideNavExpanded}
              onClick={onClickSideNavExpand}
            />
            <HeaderName as={Link} href="/" prefix="">
              Factory
            </HeaderName>
            <HeaderGlobalBar>
              <ThemeToggle />
            </HeaderGlobalBar>
            <SideNav aria-label="Side navigation" expanded={isSideNavExpanded} onSideNavBlur={onClickSideNavExpand} href="#main-content">
              <SideNavItems>
                <SideNavLink renderIcon={Dashboard} href="/dashboard" isActive>
                  Overview
                </SideNavLink>
                <SideNavLink renderIcon={Task} href="#jobs">
                  Jobs
                </SideNavLink>
                <SideNavLink renderIcon={Home} href="/">
                  Welcome
                </SideNavLink>
              </SideNavItems>
            </SideNav>
          </Header>
        )}
      />
      <Content id="main-content" className="dashboard">
        <Grid>
          <Column sm={4} md={8} lg={16} className="dashboard__heading">
            <div>
              <h1 className="cds--type-productive-heading-05">Dashboard</h1>
              <p className="cds--type-body-long-01 dashboard__muted">Signed in as {user.email}</p>
            </div>
            <SignOutButton />
          </Column>

          {STATUSES.map((status) => (
            <Column key={status} sm={2} md={2} lg={4}>
              <Tile className="dashboard__stat">
                <p className="cds--type-label-01 dashboard__muted">{STATUS_TAG[status].label}</p>
                <p className="dashboard__stat-value">{jobs.filter((job) => job.status === status).length}</p>
              </Tile>
            </Column>
          ))}

          <Column sm={4} md={8} lg={11} id="jobs">
            <TableContainer title="Recent jobs" description="Sample data — not yet connected to the runner.">
              <Table aria-label="Recent jobs">
                <TableHead>
                  <TableRow>
                    <TableHeader>Job</TableHeader>
                    <TableHeader>ID</TableHeader>
                    <TableHeader>Status</TableHeader>
                    <TableHeader>Created (UTC)</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell>{job.name}</TableCell>
                      <TableCell>
                        <code>{job.id}</code>
                      </TableCell>
                      <TableCell>
                        <Tag size="sm" type={STATUS_TAG[job.status].type}>
                          {STATUS_TAG[job.status].label}
                        </Tag>
                      </TableCell>
                      <TableCell>{timeFormat.format(new Date(job.createdAt))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Column>

          <Column sm={4} md={8} lg={5}>
            <Tile className="dashboard__runner">
              <h2 className="cds--type-productive-heading-03">Runner</h2>
              <p className="cds--type-body-long-01 dashboard__muted">Jobs are dispatched to the runner service at</p>
              <code>{runnerUrl}</code>
            </Tile>
          </Column>
        </Grid>
      </Content>
    </>
  );
}
