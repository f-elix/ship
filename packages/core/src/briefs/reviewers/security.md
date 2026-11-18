---
name: security
description: Authentication, authorisation, secrets, cryptography, injection (shell, SQL, HTML, path), untrusted input and unsafe deserialisation.
# Blocking: an exploitable hole with a traced path from untrusted input must not merge.
blocking: true
model: opus
triggers:
    paths:
        - '**/{auth,security,crypto,permissions,session,sessions}/**'
        - '**/*{auth,Auth}*'
        - '**/.env*'
    addedLines:
        - '[Pp]assw(?:or)?d|\b[Ss]ecret|[Cc]redential|[Bb]earer\b|\b[Jj][Ww][Tt]\b|[Aa]pi[_-]?[Kk]ey|API_KEY|(?:[Aa]ccess|[Rr]efresh|[Ss]ession|[Aa]uth|[Cc][Ss][Rr][Ff])[_-]?[Tt]oken'
        - '[Aa]uthori[sz]\w*\s*\(|[Aa]uthenticat\w*\s*\(|[''"][Aa]uthorization[''"]|\w[Pp]ermission|[Pp]ermissions?\s*[.(\[]|[Ss]et-?[Cc]ookie|document\.cookie|\b[Cc]ookies?\s*[.(\[]'
        - '\bcrypto\b|create(?:Hash|Hmac|Cipheriv|Decipheriv|Sign|Verify)|randomBytes|Math\.random\(|\b(?:md5|sha1|bcrypt|argon2|scrypt)\s*[.(]|[''"](?:md5|sha1|bcrypt|argon2|scrypt)[''"]'
        - '(?<![\w.$])exec(?:Sync|File|FileSync)?\s*\(|\b(?:cp|childProcess)\.exec\w*\(|\bspawn(?:Sync)?\s*\(|\bexeca\w*\(|\$`|Deno\.Command|child_process|\b(?:ChildProcess|Command)\.make\(|exec\.Command\(|Command::new\(|shell:\s*true|subprocess\.|os\.system\(|\beval\s*\(|new Function\('
        - '\b(?:SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b|[`''"]\s*(?:select\s.+\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from)\b|\bsql\s*`|^\s*(?:SELECT|INSERT|UPDATE|DELETE)\b|\.(?:raw|unsafe|query|execute)\s*\(\s*`|\$(?:query|execute)Raw(?:Unsafe)?\('
        - 'dangerouslySetInnerHTML|\.innerHTML\s*=|v-html|\{@html|pickle\.loads|yaml\.load\(|unserialize\('
---

Look for security holes the change introduces.

- Injection: untrusted input reaching a shell command, SQL, HTML, a file path, a regex or `eval` without escaping, parameters or an argument array.
- Auth: a route, RPC or action missing its authentication or authorisation check, or checking the wrong subject; privilege decided on the client.
- Secrets: credentials in code, logs, error messages, URLs or committed files; secrets passed to child processes that do not need them.
- Crypto: home-made schemes, weak hashes for passwords, `Math.random` for tokens, non-constant-time comparison of secrets, disabled TLS verification.
- Untrusted data: unsafe deserialisation, unbounded input sizes, path traversal, SSRF through user-supplied URLs, permissive CORS.

Trace the path: where the input comes from, that an attacker controls it, and that no layer sanitises it. A traced, reachable hole is `must-fix`. Hardening with no demonstrated path is `tradeoff`.

Out of scope: general error handling (error-handling), dependency vulnerabilities (deps), data integrity (data).
