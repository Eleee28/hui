import { expectTypeOf, test } from "vitest";
import type * as Api from "../api/jira.ts";
import type * as SessionApi from "../api/sessions.ts";

type LegacyJiraStatusCategory = "new" | "indeterminate" | "done";

type LegacySessionJiraIssue = {

  key: string;

  url: string;
  summary?: string;
  status?: string;
  statusCategory?: LegacyJiraStatusCategory;
  issueType?: string;

  description?: string;
};


type LegacyJiraConnection = {
  configured: boolean;
  site: string;
  email: string;
  tokenSet: boolean;
  defaultProject: string;

  accountName?: string;
};

type LegacyJiraProject = { key: string; name: string };

type LegacyJiraParentCandidate = {
  key: string;
  summary: string;
  issueType: string;

  hierarchyLevel: number;
  status?: string;
};

type LegacyJiraDraft = {
  project: string;
  parents: LegacyJiraParentCandidate[];

  parent: string;
  summary: string;
  description: string;

  model?: string;

  note?: string;

  parentChoice?: "suggested" | "unmatched" | "none-available" | "not-drafted" | "omitted";
  rejectedParent?: string;
};


type LegacyJiraIssueMatch = {
  key: string;
  url: string;
  summary: string;
  status?: string;
  statusCategory?: LegacyJiraStatusCategory;
  issueType?: string;
};


test("the schemas preserve the existing Jira payload types", () => {
  expectTypeOf<LegacyJiraStatusCategory>().toMatchTypeOf<SessionApi.JiraStatusCategory>();
  expectTypeOf<SessionApi.JiraStatusCategory>().toMatchTypeOf<LegacyJiraStatusCategory>();
  expectTypeOf<LegacySessionJiraIssue>().toMatchTypeOf<SessionApi.SessionJiraIssue>();
  expectTypeOf<SessionApi.SessionJiraIssue>().toMatchTypeOf<LegacySessionJiraIssue>();
  expectTypeOf<LegacyJiraConnection>().toMatchTypeOf<Api.JiraConnection>();
  expectTypeOf<Api.JiraConnection>().toMatchTypeOf<LegacyJiraConnection>();
  expectTypeOf<LegacyJiraProject>().toMatchTypeOf<Api.JiraProject>();
  expectTypeOf<Api.JiraProject>().toMatchTypeOf<LegacyJiraProject>();
  expectTypeOf<LegacyJiraParentCandidate>().toMatchTypeOf<Api.JiraParentCandidate>();
  expectTypeOf<Api.JiraParentCandidate>().toMatchTypeOf<LegacyJiraParentCandidate>();
  expectTypeOf<LegacyJiraDraft>().toMatchTypeOf<Api.JiraDraft>();
  expectTypeOf<Api.JiraDraft>().toMatchTypeOf<LegacyJiraDraft>();
  expectTypeOf<LegacyJiraIssueMatch>().toMatchTypeOf<Api.JiraIssueMatch>();
  expectTypeOf<Api.JiraIssueMatch>().toMatchTypeOf<LegacyJiraIssueMatch>();
});
