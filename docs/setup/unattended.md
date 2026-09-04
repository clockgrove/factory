# Unattended Linux repository controller

[Setup home](README.md) · [Local runner](local.md)

## TL;DR

1. Complete the [local quick start](local.md), including the local management login.
2. Explicitly authorize the Director to install/start the controller for your exact repo and checkout.
3. Obtain the real service unit from controller status. Configure that service separately from chat.
4. If using a cloud runner, attach its private environment file and explicitly set paid capacity;
   the default controller allows zero paid workers.
5. Verify service status and diagnostics, then authorize Objective activation. The Linux host must
   remain running; installing a plugin alone does not create an always-on scheduler.

**Success looks like:** the expected controller is active for the right checkout and the authorized
Objective is recorded in GitHub. Chat can disconnect without being the scheduler. This is a lifecycle
choice, not another worker provider: it can schedule local, sandbox, or managed work.

## Detailed service configuration


A systemd user service is not a child of your current interactive shell. It does not automatically
source `.bashrc`, inherit your latest exports, or read the agent client's configuration. Configure
the service separately even if a foreground plugin probe already works.

1. Ask Factory for `factory_controller_status` for the exact repo and checkout, or run
   `factory controller status OWNER/REPO --repo /absolute/checkout` when the npm CLI is installed.
   With a plugin-only installation, the CLI equivalent is
   `node /absolute/installed/plugin/dist/factory.js controller status OWNER/REPO --repo /absolute/checkout`.
   Obtain the real installed path from the client; do not guess a cache version. Use the returned
   `unit` value, not a made-up service name. If no controller is installed, explicitly authorize
   its installation first; plugin installation alone does not create it.
2. In that Linux user's home, create a private directory such as
   `~/.config/clockgrove-factory` with mode `0700`, and a file `providers.env` with mode `0600`.
   Edit it privately. This is an operator-chosen file, not a path Factory searches automatically.
   For Daytona, its contents have this shape (replace the placeholders; do not include `export`):

   ```dotenv
   DAYTONA_API_KEY=YOUR_DAYTONA_API_KEY
   FACTORY_DAYTONA_MODEL_SECRET=YOUR_DAYTONA_ORGANIZATION_SECRET_NAME
   ```

   Use systemd `EnvironmentFile` syntax and literal values, not shell commands or variable
   substitutions. Add only other credentials this controller actually needs. A shared file can
   serve several controllers, but each service must explicitly reference it. Use separate private
   files when repos should use different provider accounts or credentials.
3. Add a drop-in to the exact returned unit with `systemctl --user edit YOUR_EXACT_UNIT.service`:

   ```ini
   [Service]
   EnvironmentFile=%h/.config/clockgrove-factory/providers.env
   ```

   `%h` is the **service user's Linux home**, not the checkout or plugin directory. This directive
   intentionally fails service startup when the configured file is missing; silently running
   without required credentials is not the desired setup. Do not place secret values directly in
   the unit, command line, or committed files.
4. Ensure the service can also find its prerequisites. The generated unit pins Node and Factory
   executable paths, but other tools, such as a host-installed `codex` or `gh`, still need to be
   discoverable in the service's `PATH`. An interactive shell's version-manager setup is not
   automatically available to systemd. If setting `PATH` or a custom `CODEX_HOME` in a drop-in,
   use the actual absolute Linux paths; do not rely on shell expansion. The service user must be
   able to read the intended GitHub/Codex logins and checkout.
   `FACTORY_CODEX_PATH` can explicitly select a Codex executable instead of bundled/PATH resolution;
   set it to the real absolute executable path, not a command string with arguments. This is a
   runtime-location override, not an authentication setting.
5. Before restarting an active controller, ask Factory to drain it and confirm acknowledgement if
   you need an orderly stop. Restarting can interrupt active workers. Then run
   `systemctl --user daemon-reload` and restart the **exact configured unit**. Changing the file
   alone does not update a running process. A provider credential rotation likewise needs an
   affected-process restart; preserve normal provider-side revocation practices.

These instructions explain configuration; they do not install or restart a service automatically.
See [host scheduling](../HOST-SCHEDULING.md) for lifecycle and cancellation semantics. After a
plugin/package upgrade, verify that the service still references the intended installed executable
and that its drop-ins remain appropriate. A new plugin cache version does not prove an existing
controller switched binaries.


## Capacity, verification, and recovery

Before paid work, follow [capacity and spending](configuration.md#6-authorize-capacity-and-spending-separately).
The documented ExecStart override there must preserve the installed command's exact repo and paths.
Verify [the environment that executes](configuration.md#7-verify-the-same-environment-that-will-do-the-work),
not only a successful probe from chat. For Linux startup and recovery constraints, read
[host scheduling](../HOST-SCHEDULING.md). On credential or binary changes, drain before restarting
when an orderly stop is needed. Neither a new chat nor a shell export updates an existing service.
