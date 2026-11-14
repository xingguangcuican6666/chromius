/*
 * chromius-shim —— 启动拦截器。
 *
 * 原理：安装时把 Electron App 的真实二进制替换为指向本程序的符号链接。
 * 本程序被 exec 时：
 *   1. 通过 /proc/self/exe 认领自己（如果是符号链接，realpath 才是本程序；
 *      真实二进制路径由 CHROMIUS_REAL_BIN 环境变量注入 —— 见 installer）
 *   2. 连 chromiusd 的 unix socket，把「是哪个 App、原始 argv/env」发过去
 *   3. 若 daemon 回 "attached"，本进程退出（宿主接管界面）
 *   4. 否则 execve 真实二进制透传 —— 行为与未安装时完全一致（金规回退）
 *
 * 本程序**不含任何 App 专属逻辑**：App 身份由 daemon 侧根据 realBinary 结构探测。
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/stat.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define DEFAULT_SOCKET_FMT "%s/chromius/broker.sock" /* XDG_RUNTIME_DIR */
#define TIMEOUT_SECONDS 10
#define MAX_REPLY 65536

extern char **environ;

static const char *env_get(const char *name) {
    return getenv(name);
}

/* 把任意字符串转成 JSON 字符串字面量（含引号），返回 malloc 的缓冲。 */
static char *json_escape(const char *s) {
    size_t len = strlen(s);
    /* 最坏情况每个字节转成 \u00XX（6 字节）*/
    char *out = malloc(len * 6 + 3);
    if (!out) return NULL;
    size_t o = 0;
    out[o++] = '"';
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '"':  out[o++]='\\'; out[o++]='"'; break;
            case '\\': out[o++]='\\'; out[o++]='\\'; break;
            case '\n': out[o++]='\\'; out[o++]='n'; break;
            case '\r': out[o++]='\\'; out[o++]='r'; break;
            case '\t': out[o++]='\\'; out[o++]='t'; break;
            case '\b': out[o++]='\\'; out[o++]='b'; break;
            case '\f': out[o++]='\\'; out[o++]='f'; break;
            default:
                if (c < 0x20) {
                    o += (size_t)snprintf(out + o, 7, "\\u%04x", c);
                } else {
                    out[o++] = (char)c;
                }
        }
    }
    out[o++] = '"';
    out[o] = '\0';
    return out;
}

/* 动态拼接缓冲 */
typedef struct { char *buf; size_t len; size_t cap; } strbuf;

static int sb_init(strbuf *sb, size_t cap) {
    sb->buf = malloc(cap);
    if (!sb->buf) return -1;
    sb->len = 0;
    sb->cap = cap;
    sb->buf[0] = '\0';
    return 0;
}

static int sb_append(strbuf *sb, const char *s) {
    size_t n = strlen(s);
    if (sb->len + n + 1 > sb->cap) {
        size_t nc = sb->cap ? sb->cap : 256;
        while (nc < sb->len + n + 1) nc *= 2;
        char *nb = realloc(sb->buf, nc);
        if (!nb) return -1;
        sb->buf = nb;
        sb->cap = nc;
    }
    memcpy(sb->buf + sb->len, s, n + 1);
    sb->len += n;
    return 0;
}

static void sb_free(strbuf *sb) {
    free(sb->buf);
    sb->buf = NULL;
    sb->len = sb->cap = 0;
}

/* 未安装时（无 CHROMIUS_REAL_BIN）所需的“最近祖先可执行文件”逻辑不需要 —— installer
 * 总会注入 CHROMIUS_REAL_BIN。若缺失，说明是手动直接调用，直接报错退出。 */

static char *socket_path(void) {
    const char *rt = env_get("XDG_RUNTIME_DIR");
    char *p = malloc(PATH_MAX);
    if (!p) return NULL;
    if (rt && *rt) {
        snprintf(p, PATH_MAX, "%s/chromius/broker.sock", rt);
    } else {
        /* 退化到 /tmp/chromius-<uid>/chromius/broker.sock，与 paths.ts 保持一致 */
        snprintf(p, PATH_MAX, "/tmp/chromius-%d/chromius/broker.sock", (int)getuid());
    }
    return p;
}

/* 读取 /proc/self/cmdline，返回 argv 数组（malloc）。 */
static char **read_cmdline(int *argc_out) {
    int fd = open("/proc/self/cmdline", O_RDONLY);
    if (fd < 0) return NULL;
    static char buf[262144];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0) return NULL;
    buf[n] = '\0';
    int count = 0;
    for (ssize_t i = 0; i < n; i++) if (buf[i] == '\0') count++;
    char **argv = malloc(sizeof(char *) * (count + 2));
    if (!argv) return NULL;
    int idx = 0;
    char *p = buf;
    while (p < buf + n) {
        argv[idx++] = strdup(p);
        p += strlen(p) + 1;
    }
    argv[idx] = NULL;
    *argc_out = idx;
    return argv;
}

/* 尝试连接 daemon socket */
static int connect_daemon(const char *sockpath) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(sockpath) >= sizeof(addr.sun_path)) { close(fd); return -1; }
    strcpy(addr.sun_path, sockpath);
    struct timeval tv = { TIMEOUT_SECONDS, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

/* 读一行（NDJSON） */
static ssize_t read_line(int fd, char *buf, size_t cap) {
    size_t total = 0;
    while (total + 1 < cap) {
        ssize_t n = read(fd, buf + total, 1);
        if (n <= 0) break;
        if (buf[total] == '\n') { buf[total] = '\0'; return (ssize_t)total; }
        total += (size_t)n;
    }
    buf[total] = '\0';
    return (ssize_t)total;
}

/* 金规回退：execve 真实二进制。仅在透传模式下调用。 */
static void exec_real(const char *real, char **argv, char **envp) __attribute__((noreturn));
static void exec_real(const char *real, char **argv, char **envp) {
    /* 防止递归：若真实二进制本身又是 shim（几乎不可能），直接报错 */
    setenv("CHROMIUS_SHIM_ACTIVE", "1", 1);
    if (argv[0]) argv[0] = (char *)real;
    execve(real, argv, envp);
    /* execve 失败 */
    fprintf(stderr, "chromius-shim: cannot exec %s: %s\n", real, strerror(errno));
    _exit(127);
}

int main(int argc, char **argv, char **envp) {
    (void)argc;
    const char *real = env_get("CHROMIUS_REAL_BIN");
    if (!real || !*real) {
        fprintf(stderr,
                "chromius-shim: CHROMIUS_REAL_BIN not set.\n"
                "This binary is meant to be installed by 'chromius install'.\n");
        return 127;
    }

    /* 如果环境里已有 shim 标记，说明我们自己被透传了，直接 exec 防止递归 */
    if (env_get("CHROMIUS_SHIM_ACTIVE")) {
        exec_real(real, argv, envp);
    }

    char *sock = socket_path();
    if (!sock) exec_real(real, argv, envp);

    int fd = connect_daemon(sock);
    if (fd < 0) {
        /* 没有 daemon：透传，行为与今日完全一致 */
        free(sock);
        exec_real(real, argv, envp);
    }

    /* 构造 NDJSON 请求 */
    int cargc = 0;
    char **cmdl = read_cmdline(&cargc);
    if (!cmdl) { close(fd); free(sock); exec_real(real, argv, envp); }

    strbuf sb;
    if (sb_init(&sb, 1024) < 0) { close(fd); free(sock); exec_real(real, argv, envp); }

    char *e_real = json_escape(real);
    sb_append(&sb, "{\"kind\":\"launch\",\"realBinary\":");
    sb_append(&sb, e_real ? e_real : "\"\"");
    free(e_real);

    /* argv */
    sb_append(&sb, ",\"argv\":[");
    for (int i = 1; i < cargc; i++) { /* 跳过 argv[0]（是 shim 路径） */
        char *ea = json_escape(cmdl[i] ? cmdl[i] : "");
        if (i > 1) sb_append(&sb, ",");
        sb_append(&sb, ea ? ea : "\"\"");
        free(ea);
    }
    sb_append(&sb, "]");

    /* cwd */
    char cwd[PATH_MAX];
    if (!getcwd(cwd, sizeof(cwd))) cwd[0] = '\0';
    char *e_cwd = json_escape(cwd);
    sb_append(&sb, ",\"cwd\":");
    sb_append(&sb, e_cwd ? e_cwd : "\"\"");
    free(e_cwd);

    /* env 只传 daemon 需要的最小集合（避免超大请求 + 泄露敏感变量） */
    sb_append(&sb, ",\"env\":{");
    const char *keys[] = {"WAYLAND_DISPLAY", "DISPLAY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE",
                          "XDG_CURRENT_DESKTOP", "HOME", "USER", "LANG", "TZ", NULL};
    int first = 1;
    for (int i = 0; keys[i]; i++) {
        const char *v = env_get(keys[i]);
        if (!v) continue;
        char *ev = json_escape(v);
        if (!first) sb_append(&sb, ",");
        first = 0;
        sb_append(&sb, "\"");
        sb_append(&sb, keys[i]);
        sb_append(&sb, "\":");
        sb_append(&sb, ev ? ev : "\"\"");
        free(ev);
    }
    sb_append(&sb, "}}\n");

    /* 发送 */
    size_t off = 0;
    while (off < sb.len) {
        ssize_t w = write(fd, sb.buf + off, sb.len - off);
        if (w <= 0) break;
        off += (size_t)w;
    }
    sb_free(&sb);

    /* 等待回复 */
    char reply[MAX_REPLY];
    ssize_t rn = read_line(fd, reply, sizeof(reply));
    close(fd);
    free(sock);

    /* 判定：reply 含 "attached":true → 宿主接管，退出；否则透传 */
    if (rn > 0 && strstr(reply, "\"attached\":true") != NULL) {
        return 0;
    }
    if (rn > 0 && strstr(reply, "\"ok\":true") != NULL && strstr(reply, "\"mode\"") != NULL) {
        /* daemon 回了 ok 但结构不同，保守起见也退出（由 daemon 日志排查） */
        return 0;
    }
    exec_real(real, argv, envp);
}
