import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const msg = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

/** Ready-made workflows exposed as MCP prompts (slash commands in most clients). */
export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "new_server",
    {
      title: "Create a server",
      description: "Guided creation of a cloud server for a given purpose",
      argsSchema: { purpose: z.string().describe("What the server is for, e.g. 'small web app with docker'") },
    },
    ({ purpose }) =>
      msg(
        `I need a Selectel cloud server for: ${purpose}.
1. Call selectel_status, then regions_list, flavors_list, images_list (prefer a current Ubuntu LTS), keypairs_list, networks_list, volume_types_list.
2. Propose a configuration (region, vCPU/RAM, disk size and type, image, SSH key, network, floating IP or not, security group rules) with a short justification. Keep it minimal — I can resize later.
3. If useful, draft cloud-init user_data (create a sudo user with my SSH key, disable password SSH login, enable unattended upgrades, install what the purpose needs).
4. Only after I approve the proposal, call server_create and show me the plan before confirming.
5. When it is ACTIVE, give me the IPs and the ssh command.`,
      ),
  );

  server.registerPrompt(
    "cost_audit",
    { title: "Cost audit", description: "Find where money goes and what can be cut" },
    () =>
      msg(
        `Audit my Selectel spending. Use infra_overview and billing_report (group_by service and object for the current and previous month).
Report: balance and days left, top consumers, and waste candidates: stopped (SHUTOFF) servers that are still billed, unattached volumes, unattached floating IPs, old snapshots, oversized servers.
For each candidate give an estimated saving if the data allows it. Do not change anything — only suggest actions.`,
      ),
  );

  server.registerPrompt(
    "dns_migrate",
    {
      title: "Migrate a DNS zone to Selectel",
      description: "Move a domain's DNS from another provider to Selectel DNS",
      argsSchema: {
        domain: z.string().describe("Domain, e.g. example.com"),
        zone_file: z.string().optional().describe("BIND zone file exported from the current provider (optional)"),
      },
    },
    ({ domain, zone_file }) =>
      msg(
        `Migrate DNS for ${domain} to Selectel.
1. dns_zones_list — create the zone with dns_zone_create if it does not exist.
2. ${zone_file ? "Import the zone file below with dns_import_bind" : "Ask me for an exported BIND zone file or a list of records, then use dns_import_bind or dns_records_apply"}. Show me the diff plan first.
3. After applying, list the records and compare with the source; point out anything skipped (SOA/NS, unsupported types).
4. Tell me which NS servers to set at my registrar, and remind me to keep the old DNS running until the TTL of the old NS records expires.
${zone_file ? `\nZone file:\n\`\`\`\n${zone_file}\n\`\`\`` : ""}`,
      ),
  );

  server.registerPrompt(
    "server_report",
    {
      title: "Server report",
      description: "Everything about one server",
      argsSchema: { server: z.string().describe("Server name or id") },
    },
    ({ server: s }) =>
      msg(
        `Give me a concise report on server "${s}": use server_find then server_get. Include status, region, flavor, IPs (public/private/floating), disks with sizes and types, security groups with open ports (security_groups_list), DNS records pointing at its IPs if any zones exist (dns_records_list), and the last 30 lines of console log if the server is not ACTIVE.`,
      ),
  );
}
