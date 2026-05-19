# @shopify/ucp-cli

## 0.5.0

### Minor Changes

- 4c2c387: Drop the `~/.ucp/hooks/escalation` file-source for escalation hooks. The escalation hook contract is now three sources — `--on-escalation` flag, `UCP_ON_ESCALATION` env, `~/.ucp/config.yaml` `escalation.command` — all shell command strings, identical on every OS.

  The file convention duplicated config-source ("put your command in a file" vs "point config at a file"), had no meaningful `X_OK` semantics on Windows, and forced platform asymmetry users had to learn around. To run an existing script, point config at it directly:

  ```yaml
  # POSIX
  escalation:
    command: '/path/to/escalation.sh'

  # Windows
  escalation:
    command: 'powershell -NoProfile -File C:\path\escalation.ps1'
  ```

## 0.4.3

### Patch Changes

- f720ae7: Fix the installed package bin so package-manager symlinks run the CLI instead of exiting 0 with no output.
