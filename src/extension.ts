/// <reference types="node" />
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as jschardet from 'jschardet';
import * as iconv from 'iconv-lite';
import { StringDecoder } from 'string_decoder';
import { WriteOperationDetector, WritePatterns, buildIdentifierSearchRegex, chooseMatchRange, isDashCommentFile, isFunctionCall, isHashCommentFile } from './writeDetector';

interface SearchResult {
    file: string;
    fileName: string;
    line: number;
    lineContent: string;
    isWrite: boolean;
    // 这一处是函数或方法调用。定义、声明，以及只把名字当普通值用的地方不是调用
    isCall: boolean;
    matchStart?: number;
    matchEnd?: number;
    functionName?: string;
    // 取不到函数名时展示给用户的说明（例如该语言没有符号提供者）
    functionNameHint?: string;
}

// 写操作检测器：检测规则来自 searchhighlight.patterns 配置
const writeDetector = new WriteOperationDetector();

// 从配置读取写操作检测规则
function reloadWritePatterns(): void {
    const config = vscode.workspace.getConfiguration('searchhighlight');
    writeDetector.setPatterns(config.get<WritePatterns>('patterns') || {});
}

reloadWritePatterns();

// 文件中的符号范围信息
interface SymbolRange {
    name: string;
    startLine: number;
    endLine: number;
    isFunction: boolean;
    parentName?: string;
    // 所属容器本身是否也是函数（嵌套函数/回调），此时不作为“类”展示
    parentIsFunction: boolean;
}

// 语言服务对匿名函数有时会返回 <function> 这类占位名，展示时不能直接使用
const ANONYMOUS_SYMBOL_NAMES = new Set([
    '<function>',
    '<anonymous>',
    '<anonymous function>',
    '(anonymous)',
    '(anonymous function)',
    '<lambda>',
    'anonymous'
]);

// 函数列的展示长度上限，超出后截断，避免过长的函数名挤占行内容
const MAX_FUNCTION_DISPLAY_LENGTH = 30;

// 只保留符号名本身：去掉签名参数、泛型参数等多余部分
function simplifySymbolName(raw: string | undefined): string | undefined {
    if (!raw) {
        return undefined;
    }
    // foo(a, b): void -> foo，foo<T> -> foo
    const name = raw.trim().replace(/[（(].*$/, '').replace(/<.*$/, '').trim();
    if (!name || ANONYMOUS_SYMBOL_NAMES.has(name.toLowerCase())) {
        return undefined;
    }
    return name;
}

// 所属类/命名空间只保留最后一段：a.b.MyClass -> MyClass
function simplifyContainerName(raw: string | undefined): string | undefined {
    const name = simplifySymbolName(raw);
    if (!name) {
        return undefined;
    }
    const segments = name.split(/[.:/\\]+/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : name;
}

// 组合出展示用的函数名，超出长度上限时截断
function buildFunctionDisplay(containerName: string | undefined, functionName: string | undefined): string | undefined {
    if (!functionName) {
        return containerName;
    }
    const display = containerName ? `${containerName}:${functionName}` : functionName;
    return display.length > MAX_FUNCTION_DISPLAY_LENGTH
        ? `${display.slice(0, MAX_FUNCTION_DISPLAY_LENGTH)}…`
        : display;
}

// 解码后的行内容
interface DecodedLine {
    text: string;
    encoding: string;
    // 非 UTF-8 时保留原始字节，用于把 ripgrep 的字节偏移换算成字符下标
    raw?: Buffer;
}

// 是否输出调试日志，由配置 searchhighlight.debug 控制
let debugEnabled = false;

function debugLog(...args: unknown[]): void {
    if (debugEnabled) {
        console.log(...args);
    }
}

// Windows 上路径不区分大小写，统一转成比较用的键
function pathKey(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// 搜索结果的定位键（文件 + 行号），用于去重
function locationKey(filePath: string, line: number): string {
    return `${pathKey(filePath)}:${line}`;
}

// 读取文件最后修改时间（毫秒），读不到时返回 undefined
function getFileMtimeMs(filePath: string): number | undefined {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return undefined;
    }
}

// 文件在编辑器里存在未保存的修改，此时缓存内容可能已经过期
function isDocumentDirty(filePath: string): boolean {
    const key = pathKey(filePath);
    return vscode.workspace.textDocuments.some(doc => doc.isDirty && pathKey(doc.uri.fsPath) === key);
}

// 缓存条目超过上限时，按插入顺序淘汰最早的条目
function evictOldest<K, V>(cache: Map<K, V>, maxSize: number): void {
    if (cache.size <= maxSize) {
        return;
    }
    const overflow = cache.size - maxSize;
    let removed = 0;
    for (const key of cache.keys()) {
        cache.delete(key);
        if (++removed >= overflow) {
            break;
        }
    }
}

// 语言服务可能一直不返回。到时就放弃这次查询，改走别的搜索方式
function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<{ value?: T; timedOut: boolean; error?: unknown }> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve({ timedOut: true }), ms);
        Promise.resolve(promise).then(
            value => {
                clearTimeout(timer);
                resolve({ value, timedOut: false });
            },
            error => {
                clearTimeout(timer);
                resolve({ timedOut: false, error });
            }
        );
    });
}

// 符号解析结果
interface SymbolRangesResult {
    ranges: SymbolRange[];
    // 该语言没有注册符号提供者（与“有提供者但没有符号”区分开）
    providerMissing: boolean;
}

// 符号解析缓存条目
interface SymbolCacheEntry {
    mtimeMs: number | undefined;
    ranges: Promise<SymbolRangesResult>;
    // 空结果可能只是语言服务还没就绪，只做短期缓存，过期后重新尝试
    expiresAt?: number;
}

// 解析搜索结果所在函数/方法的解析器
class FunctionResolver {
    // 缓存每个文件解析出的符号范围，跨搜索复用，用文件修改时间判断是否过期
    private cache = new Map<string, SymbolCacheEntry>();

    // 缓存文件数上限，避免长期运行后占用过多内存
    private static readonly MAX_CACHE_FILES = 2000;

    // 取不到符号时的缓存有效期（毫秒）：语言服务可能稍后才就绪，不能一直沿用空结果
    private static readonly EMPTY_CACHE_TTL_MS = 30 * 1000;

    // 没有符号提供者的文件类型（按扩展名）-> 重新探测的时间点
    private missingProviderExtensions = new Map<string, number>();

    // 没有符号提供者时的记录有效期：语言服务可能在插件之后才激活，需要定期重新探测
    private static readonly MISSING_PROVIDER_TTL_MS = 5 * 60 * 1000;

    private static readonly FUNCTION_KINDS = new Set<vscode.SymbolKind>([
        vscode.SymbolKind.Function,
        vscode.SymbolKind.Method,
        vscode.SymbolKind.Constructor
    ]);

    public clearCache(): void {
        this.cache.clear();
        this.missingProviderExtensions.clear();
    }

    // 一次搜索中最多解析的文件数，超过后跳过函数名解析，避免大量文档被语言服务解析
    private static readonly MAX_ENRICH_FILES = 500;

    // 批量补充搜索结果中的函数/方法名
    public async enrichResults(results: SearchResult[], token?: vscode.CancellationToken): Promise<void> {
        if (results.length === 0) {
            return;
        }

        const files = Array.from(new Set(results.map(result => result.file)));
        if (files.length > FunctionResolver.MAX_ENRICH_FILES) {
            debugLog(`命中文件过多(${files.length})，跳过函数名解析`);
            for (const result of results) {
                result.functionNameHint = '命中文件过多，已跳过函数名解析';
            }
            return;
        }

        const rangesByFile = new Map<string, SymbolRangesResult>();

        // 限制并发数量，避免同时解析过多文档导致卡顿
        const concurrency = Math.min(4, files.length);
        let nextIndex = 0;
        const workers = Array.from({ length: concurrency }, async () => {
            while (nextIndex < files.length && !token?.isCancellationRequested) {
                const file = files[nextIndex++];
                rangesByFile.set(file, await this.getSymbolRanges(file));
            }
        });
        await Promise.all(workers);

        let missingProviderFiles = 0;
        let resolvedCount = 0;
        for (const result of results) {
            const entry = rangesByFile.get(result.file);
            // 搜索被取消等原因导致没有解析结果时跳过，避免给出误导性的说明
            if (!entry) {
                continue;
            }
            result.functionName = this.findEnclosingFunction(entry.ranges, result.line);
            if (result.functionName) {
                resolvedCount++;
                continue;
            }
            // 取不到函数名时说明原因，避免用户以为是插件失效
            result.functionNameHint = entry.providerMissing
                ? '该语言没有可用的符号提供者，无法解析函数名'
                : '该行不在任何函数或方法内';
        }

        for (const entry of rangesByFile.values()) {
            if (entry.providerMissing) {
                missingProviderFiles++;
            }
        }
        debugLog(`函数名解析：文件 ${files.length} 个，解析成功 ${resolvedCount} 条结果，无符号提供者的文件 ${missingProviderFiles} 个`);
    }

    private getSymbolRanges(filePath: string): Promise<SymbolRangesResult> {
        // 已知该类型没有符号提供者时直接跳过，避免对同类型文件反复查询语言服务
        const extension = path.extname(filePath).toLowerCase();
        const missingUntil = this.missingProviderExtensions.get(extension);
        if (missingUntil !== undefined && Date.now() < missingUntil) {
            return Promise.resolve({ ranges: [], providerMissing: true });
        }

        const key = pathKey(filePath);
        const mtimeMs = getFileMtimeMs(filePath);
        const cached = this.cache.get(key);
        const expired = cached?.expiresAt !== undefined && Date.now() >= cached.expiresAt;
        // 文件没被改动过时直接复用缓存；有未保存修改或短期缓存已过期时重新解析
        if (cached && !expired && cached.mtimeMs === mtimeMs && !isDocumentDirty(filePath)) {
            return cached.ranges;
        }

        const ranges = this.loadSymbolRanges(filePath);
        const entry: SymbolCacheEntry = { mtimeMs, ranges };
        this.cache.set(key, entry);
        void ranges.then(result => {
            if (result.providerMissing) {
                // 该语言没有符号提供者：按扩展名记住一段时间，不再逐个文件查询
                this.missingProviderExtensions.set(extension, Date.now() + FunctionResolver.MISSING_PROVIDER_TTL_MS);
                if (this.cache.get(key) === entry) {
                    this.cache.delete(key);
                }
                return;
            }
            // 有提供者但结果为空，可能只是语言服务还没就绪，只做短期缓存
            if (result.ranges.length === 0 && this.cache.get(key) === entry) {
                entry.expiresAt = Date.now() + FunctionResolver.EMPTY_CACHE_TTL_MS;
            }
        });
        evictOldest(this.cache, FunctionResolver.MAX_CACHE_FILES);
        return ranges;
    }

    // 通过文档符号提供者获取文件中的所有符号范围
    private async loadSymbolRanges(filePath: string): Promise<SymbolRangesResult> {
        try {
            const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
                'vscode.executeDocumentSymbolProvider',
                vscode.Uri.file(filePath)
            );

            // 该命令在没有注册符号提供者时返回 undefined，返回空数组则表示有提供者但没有符号
            if (symbols === undefined || symbols === null) {
                return { ranges: [], providerMissing: true };
            }
            if (symbols.length === 0) {
                return { ranges: [], providerMissing: false };
            }

            const ranges: SymbolRange[] = [];
            const visit = (items: Array<vscode.DocumentSymbol | vscode.SymbolInformation>, parent?: vscode.DocumentSymbol | vscode.SymbolInformation) => {
                for (const item of items) {
                    const range = 'range' in item ? item.range : item.location.range;
                    // 部分语言的符号提供者返回的是扁平的 SymbolInformation，用 containerName 作为所属类/命名空间
                    const containerName = (item as vscode.SymbolInformation).containerName;
                    const parentName = parent?.name || (containerName && containerName !== item.name ? containerName : undefined);
                    ranges.push({
                        name: item.name,
                        startLine: range.start.line,
                        endLine: range.end.line,
                        isFunction: FunctionResolver.FUNCTION_KINDS.has(item.kind),
                        parentName,
                        parentIsFunction: parent ? FunctionResolver.FUNCTION_KINDS.has(parent.kind) : false
                    });

                    const children = (item as vscode.DocumentSymbol).children;
                    if (children && children.length > 0) {
                        visit(children, item);
                    }
                }
            };
            visit(symbols);
            return { ranges, providerMissing: false };
        } catch (error) {
            // 部分语言没有符号提供者，这里只是拿不到函数名，不必刷错误日志
            debugLog(`解析文件符号失败: ${filePath}`, error);
            // 出错可能是语言服务还没就绪，不能当成“没有提供者”长期记下
            return { ranges: [], providerMissing: false };
        }
    }

    // 取包含该行且范围最小的函数/方法，嵌套时取最内层
    private findEnclosingFunction(ranges: SymbolRange[], line: number): string | undefined {
        let target: SymbolRange | undefined;
        for (const range of ranges) {
            if (!range.isFunction || line < range.startLine || line > range.endLine) {
                continue;
            }
            if (!target || (range.endLine - range.startLine) < (target.endLine - target.startLine)) {
                target = range;
            }
        }

        if (!target) {
            return undefined;
        }
        // 匿名函数（例如 <function>）取不到名字时，退回所属的类或外层函数
        const functionName = simplifySymbolName(target.name);
        const containerName = simplifyContainerName(target.parentName);
        if (!functionName) {
            return buildFunctionDisplay(undefined, containerName);
        }
        // 方法展示为“类:函数”，例如 MyClass:Foo；嵌套在函数里的函数只显示函数名
        if (containerName && !target.parentIsFunction) {
            return buildFunctionDisplay(containerName, functionName);
        }
        return buildFunctionDisplay(undefined, functionName);
    }
}

// 创建函数解析器实例
const functionResolver = new FunctionResolver();

// 修改 RipGrep 搜索类
class RipGrepSearch {
    private rgPath: string;
    // 是否已经提示过 ripgrep 缺失，避免重复弹窗
    private static rgMissingReported = false;
    // VS Code 目录、Cursor / Trae 等目录和 PATH 都找不到时，搜索前弹给用户的说明
    private static missingHint = '';
    // 文件编码缓存，避免同一个文件的每一行都做一次编码检测（跨搜索复用，按修改时间失效）
    private static readonly encodingCache = new Map<string, { mtimeMs: number | undefined; encoding: string }>();
    // 编码缓存的文件数上限
    private static readonly MAX_ENCODING_CACHE_FILES = 5000;
    // 编码检测的采样大小
    private static readonly ENCODING_SAMPLE_SIZE = 64 * 1024;
    // 可以信任的编码（多字节/CJK 编码），其余检测结果需要复核
    private static readonly TRUSTED_ENCODINGS = new Set([
        'utf8', 'ascii', 'gb2312', 'gbk', 'gb18030', 'big5', 'big5hkscs',
        'shiftjis', 'eucjp', 'euckr', 'iso2022jp', 'utf16le', 'utf16be', 'unicode'
    ]);
    // 传递到 webview 的单行最大长度
    private static readonly MAX_LINE_LENGTH = 4000;

    // 流式推送结果的合并间隔（毫秒），避免结果很多时频繁刷新界面
    private static readonly RESULT_FLUSH_INTERVAL = 120;
    // 结果页一次最多画这么多条。再多的话 Cursor 会把整页清成空白
    private static readonly MAX_VIEW_RESULTS = 500;
    // 无论配置如何都必须排除的目录，避免 --no-ignore 时遍历版本库元数据
    private static readonly MANDATORY_EXCLUDE_DIRS = ['.git', '.hg', '.svn'];
    // 符号数据库查询超时：语言服务没就绪时不要一直卡住，超时后改用 ripgrep
    private static readonly SYMBOL_QUERY_TIMEOUT_MS = 4000;
    // 单个符号的引用查询超时
    private static readonly REFERENCE_QUERY_TIMEOUT_MS = 2500;
    // 同名符号太多时，逐个展开引用又慢又不完整，改用全文搜索
    private static readonly MAX_SYMBOLS_TO_EXPAND = 30;
    constructor() {
        this.rgPath = RipGrepSearch.resolveRipGrepPath();
        debugLog(this.rgPath ? `RipGrep 路径: ${this.rgPath}` : `RipGrep 未找到。${RipGrepSearch.missingHint}`);
    }

    // 每次搜索重新检测文件编码
    public static clearEncodingCache(): void {
        RipGrepSearch.encodingCache.clear();
    }

    public refreshRipGrepPath(): void {
        // 先允许再次提示，再重新查找。否则这次查找弹出的提示会被马上清掉
        RipGrepSearch.rgMissingReported = false;
        this.rgPath = RipGrepSearch.resolveRipGrepPath();
        debugLog(this.rgPath ? `RipGrep 路径已更新: ${this.rgPath}` : `RipGrep 未找到。${RipGrepSearch.missingHint}`);
    }

    // 依次尝试：用户指定路径、当前编辑器和 VS Code 安装目录、Cursor / Trae 等二次开发编辑器、PATH。
    // 这些地方都没有时只记下说明，等用户真正搜索时再提示去设置路径。
    private static resolveRipGrepPath(): string {
        RipGrepSearch.missingHint = '';
        const exeName = process.platform === 'win32' ? 'rg.exe' : 'rg';
        const configuredPath = vscode.workspace.getConfiguration('searchhighlight').get<string>('ripgrepPath', '').trim();
        let invalidConfiguredPath = '';
        if (configuredPath) {
            const resolved = path.resolve(configuredPath);
            if (RipGrepSearch.isExistingFile(resolved)) {
                return resolved;
            }
            invalidConfiguredPath = resolved;
            debugLog(`配置的 ripgrep 路径不存在: ${resolved}`);
        }

        // 先找本机 VS Code、VS Code Insiders，以及当前编辑器自己的安装目录
        const vsCodeRoots = RipGrepSearch.uniqueRoots([
            ...RipGrepSearch.getVsCodeInstallAppRoots(),
            ...RipGrepSearch.getEditorAppRoots()
        ]);
        const fromVsCode = RipGrepSearch.findInAppRoots(vsCodeRoots, exeName);
        if (fromVsCode) {
            return fromVsCode;
        }

        // VS Code 目录里没有，再找 Cursor、Trae 等基于 VS Code 二次开发的编辑器
        const vsCodeRootSet = new Set(vsCodeRoots);
        const forkRoots = RipGrepSearch.getForkInstallAppRoots().filter(root => !vsCodeRootSet.has(root));
        const fromFork = RipGrepSearch.findInAppRoots(forkRoots, exeName);
        if (fromFork) {
            debugLog(`VS Code 安装目录中未找到 ripgrep，改用其他编辑器目录: ${fromFork}`);
            return fromFork;
        }

        // 最后检查 PATH，支持用户自行安装的 ripgrep
        const onPath = RipGrepSearch.findRipGrepOnPath();
        if (onPath) {
            debugLog(`安装目录中未找到 ripgrep，改用 PATH: ${onPath}`);
            return onPath;
        }

        RipGrepSearch.missingHint = invalidConfiguredPath
            ? `填写的 ripgrep 路径不存在：${invalidConfiguredPath}。VS Code、Cursor、Trae 这些目录里也没有找到 rg，请重新设置路径。`
            : '没有在 VS Code 安装目录里找到 ripgrep（rg），在 Cursor、Trae 等编辑器目录和 PATH 里也没有找到。请设置 rg 的路径后再搜索。';
        debugLog(RipGrepSearch.missingHint);
        return '';
    }

    // 编辑器目录和其他目录都找不到时，提示用户去设置里填写 rg 路径
    private static promptToSetRipGrepPath(): void {
        if (RipGrepSearch.rgMissingReported) {
            return;
        }
        RipGrepSearch.rgMissingReported = true;
        const message = RipGrepSearch.missingHint
            || '没有在 VS Code 安装目录里找到 ripgrep（rg），在 Cursor、Trae 等编辑器目录里也没有找到。请设置 rg 的路径后再搜索。';
        void vscode.window.showErrorMessage(message, '设置 ripgrep 路径').then(action => {
            if (action) {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'searchhighlight.ripgrepPath');
            }
        });
    }

    private static isExistingFile(candidate: string): boolean {
        try {
            return !!candidate && fs.statSync(candidate).isFile();
        } catch {
            return false;
        }
    }

    private static addAppRoot(appRoots: Set<string>, candidate: string | undefined): void {
        if (candidate) {
            appRoots.add(path.resolve(candidate));
        }
    }

    // 当前正在使用的编辑器安装目录
    private static getEditorAppRoots(): string[] {
        const appRoots = new Set<string>();
        RipGrepSearch.addAppRoot(appRoots, vscode.env.appRoot);
        RipGrepSearch.addAppRoot(appRoots, process.env.VSCODE_PORTABLE);

        // 某些编辑器的 appRoot 可能不可用，从当前程序向上找标准的 resources/app 布局
        let executableDir = path.dirname(process.execPath);
        for (let depth = 0; depth < 6; depth++) {
            RipGrepSearch.addAppRoot(appRoots, executableDir);
            RipGrepSearch.addAppRoot(appRoots, path.join(executableDir, 'resources', 'app'));
            const parent = path.dirname(executableDir);
            if (parent === executableDir) {
                break;
            }
            executableDir = parent;
        }
        return [...appRoots];
    }

    private static uniqueRoots(candidates: string[]): string[] {
        return [...new Set(candidates)];
    }

    // 本机 VS Code、VS Code Insiders 的默认安装目录
    private static getVsCodeInstallAppRoots(): string[] {
        const roots = RipGrepSearch.getNamedProductAppRoots(
            ['Microsoft VS Code', 'Microsoft VS Code Insiders'],
            ['Visual Studio Code', 'Visual Studio Code - Insiders'],
            ['code', 'code-insiders', 'code-oss', 'visual-studio-code']
        );
        if (process.platform !== 'win32' && process.platform !== 'darwin') {
            roots.push('/snap/code/current/usr/share/code/resources/app');
        }
        return RipGrepSearch.uniqueRoots(roots);
    }

    // VS Code 目录里没有 rg 时，再看这些基于 VS Code 二次开发的编辑器
    private static readonly FORK_PRODUCT_NAMES = [
        'cursor', 'Cursor',
        'Trae', 'Trae CN',
        'Windsurf',
        'VSCodium',
        'Kiro',
        'CodeBuddy',
        'Qoder'
    ];

    private static getForkInstallAppRoots(): string[] {
        const macNames = RipGrepSearch.FORK_PRODUCT_NAMES.filter(name => name !== 'cursor');
        const linuxNames = [
            ...RipGrepSearch.FORK_PRODUCT_NAMES,
            'trae', 'windsurf', 'codium', 'vscodium', 'kiro', 'codebuddy', 'qoder'
        ];
        return RipGrepSearch.getNamedProductAppRoots(
            RipGrepSearch.FORK_PRODUCT_NAMES,
            macNames,
            linuxNames
        );
    }

    // 按软件名字拼出 resources/app，不扫描安装目录下的全部程序
    private static getNamedProductAppRoots(windowsNames: string[], macAppNames: string[], linuxNames: string[]): string[] {
        const appRoots = new Set<string>();
        if (process.platform === 'win32') {
            const bases = [
                process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '',
                process.env.ProgramFiles || '',
                process.env['ProgramFiles(x86)'] || ''
            ];
            for (const base of bases.filter(Boolean)) {
                for (const name of windowsNames) {
                    RipGrepSearch.addAppRoot(appRoots, path.join(base, name, 'resources', 'app'));
                }
            }
        } else if (process.platform === 'darwin') {
            const bases = ['/Applications', path.join(process.env.HOME || '', 'Applications')];
            for (const base of bases) {
                for (const name of macAppNames) {
                    RipGrepSearch.addAppRoot(appRoots, path.join(base, `${name}.app`, 'Contents', 'Resources', 'app'));
                }
            }
        } else {
            for (const base of ['/usr/share', '/usr/lib', '/opt']) {
                for (const name of linuxNames) {
                    RipGrepSearch.addAppRoot(appRoots, path.join(base, name, 'resources', 'app'));
                }
            }
        }
        return [...appRoots];
    }

    private static findInAppRoots(appRoots: string[], exeName: string): string | undefined {
        for (const appRoot of appRoots) {
            for (const relativeDir of RipGrepSearch.RIPGREP_BIN_DIRS) {
                const found = RipGrepSearch.findRipGrepInDir(path.join(appRoot, relativeDir), exeName);
                if (found) {
                    return found;
                }
            }
        }
        return undefined;
    }

    // VS Code 不同版本内置 ripgrep 的存放位置
    private static readonly RIPGREP_BIN_DIRS = [
        path.join('node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin'),
        path.join('node_modules', '@vscode', 'ripgrep-universal', 'bin'),
        path.join('node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin'),
        path.join('node_modules', '@vscode', 'ripgrep', 'bin'),
        path.join('node_modules', 'vscode-ripgrep', 'bin')
    ];

    // 可执行文件可能直接放在 bin 目录下，也可能放在 bin/<平台>-<架构>/ 子目录下
    private static findRipGrepInDir(binDir: string, exeName: string): string | undefined {
        const direct = path.join(binDir, exeName);
        if (RipGrepSearch.isExistingFile(direct)) {
            return direct;
        }

        try {
            for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const candidate = path.join(binDir, entry.name, exeName);
                if (RipGrepSearch.isExistingFile(candidate)) {
                    return candidate;
                }
            }
        } catch {
            // bin 目录不存在时忽略，继续尝试下一个位置
        }
        return undefined;
    }

    private static findRipGrepOnPath(): string | undefined {
        const locator = process.platform === 'win32' ? 'where' : 'which';
        try {
            const result = cp.spawnSync(locator, ['rg'], { encoding: 'utf8', windowsHide: true });
            const found = (result.stdout || '')
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)[0];
            if (result.status === 0 && found && RipGrepSearch.isExistingFile(found)) {
                return found;
            }
        } catch (error) {
            console.error('查找 PATH 中的 rg 失败:', error);
        }
        return undefined;
    }

    // 构建与 highlightSearchText 一致的匹配正则，用于 ripgrep 未提供匹配位置时的兜底
    static buildSearchRegex(searchText: string, caseSensitive: boolean, matchWholeWord: boolean): RegExp {
        return buildIdentifierSearchRegex(searchText, caseSensitive, matchWholeWord);
    }

    // 解析 --json 输出中的路径字段
    private static decodePath(pathField: { text?: string; bytes?: string } | undefined): string | undefined {
        if (!pathField) {
            return undefined;
        }
        if (typeof pathField.text === 'string') {
            return pathField.text;
        }
        if (typeof pathField.bytes === 'string') {
            return Buffer.from(pathField.bytes, 'base64').toString('utf8');
        }
        return undefined;
    }

    // 解析 --json 输出中的行内容：非 UTF-8 文件会被 ripgrep 以 base64 字节返回
    private static decodeLines(linesField: { text?: string; bytes?: string } | undefined, filePath: string): DecodedLine {
        if (!linesField) {
            return { text: '', encoding: 'utf8' };
        }
        if (typeof linesField.text === 'string') {
            return { text: linesField.text, encoding: 'utf8' };
        }
        if (typeof linesField.bytes === 'string') {
            const buffer = Buffer.from(linesField.bytes, 'base64');
            const encoding = RipGrepSearch.resolveFileEncoding(filePath, buffer);
            try {
                return { text: iconv.decode(buffer, encoding), encoding, raw: buffer };
            } catch (error) {
                console.error(`解码错误(${encoding}):`, error);
                return { text: buffer.toString('utf8'), encoding: 'utf8' };
            }
        }
        return { text: '', encoding: 'utf8' };
    }

    // 同一个文件的编码只检测一次：优先用整份文件的开头样本，避免单行样本误判
    private static resolveFileEncoding(filePath: string, lineSample: Buffer): string {
        const key = pathKey(filePath);
        const mtimeMs = getFileMtimeMs(filePath);
        const cached = RipGrepSearch.encodingCache.get(key);
        if (cached && cached.mtimeMs === mtimeMs && !isDocumentDirty(filePath)) {
            return cached.encoding;
        }

        let sample = lineSample;
        try {
            const fd = fs.openSync(filePath, 'r');
            try {
                const buffer = Buffer.alloc(RipGrepSearch.ENCODING_SAMPLE_SIZE);
                const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
                if (read > 0) {
                    sample = buffer.subarray(0, read);
                }
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            // 读不到文件时退回到当前行样本
        }

        const encoding = RipGrepSearch.detectEncoding(sample);
        RipGrepSearch.encodingCache.set(key, { mtimeMs, encoding });
        evictOldest(RipGrepSearch.encodingCache, RipGrepSearch.MAX_ENCODING_CACHE_FILES);
        return encoding;
    }

    // 判断某一行是否属于注释。// 和 /* 对所有语言生效，# 与 -- 只在使用它们的语言里生效
    private static isCommentLine(filePath: string, trimmedLine: string): boolean {
        if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*')) {
            return true;
        }
        if (trimmedLine.startsWith('#') && isHashCommentFile(filePath)) {
            return true;
        }
        return trimmedLine.startsWith('--') && isDashCommentFile(filePath);
    }

    // 判断样本编码，检测结果不可信时按 GB18030 处理
    private static detectEncoding(sample: Buffer): string {
        if (sample.length === 0) {
            return 'utf8';
        }

        const detected = jschardet.detect(sample);
        const encoding = detected && detected.encoding ? detected.encoding : 'utf8';
        const normalized = encoding.toLowerCase().replace(/[-_]/g, '');
        if (RipGrepSearch.TRUSTED_ENCODINGS.has(normalized)) {
            return encoding;
        }

        // 检测成西欧单字节编码、但样本里高位字节占比很高时基本可以确定是误判，
        // 中文环境下按 GB18030 解码（GBK/GB2312 的超集）
        if (RipGrepSearch.highByteRatio(sample) > 0.15) {
            return 'gb18030';
        }
        return encoding;
    }

    private static highByteRatio(sample: Buffer): number {
        if (sample.length === 0) {
            return 0;
        }
        let high = 0;
        for (const byte of sample) {
            if (byte >= 0x80) {
                high++;
            }
        }
        return high / sample.length;
    }

    // 计算这一行里每一次被搜索字符串的位置。优先使用 ripgrep 的字节偏移
    private static resolveMatchRanges(content: string, submatches: any, fallbackRegex: RegExp, decoded: DecodedLine): { start: number; end: number }[] {
        const ranges: { start: number; end: number }[] = [];
        if (Array.isArray(submatches)) {
            for (const sub of submatches) {
                if (typeof sub?.start !== 'number' || typeof sub?.end !== 'number') {
                    continue;
                }
                const start = RipGrepSearch.byteOffsetToCharIndex(decoded, sub.start);
                const end = RipGrepSearch.byteOffsetToCharIndex(decoded, sub.end);
                if (end > start) {
                    ranges.push({ start, end });
                }
            }
        }
        if (ranges.length > 0) {
            return ranges;
        }

        // 兜底：按搜索条件自己再匹配每一次
        fallbackRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = fallbackRegex.exec(content)) !== null) {
            if (match[0].length === 0) {
                fallbackRegex.lastIndex++;
                continue;
            }
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }
        return ranges;
    }

    // 用同一编码解码字节前缀，把字节偏移精确换算成字符下标
    private static byteOffsetToCharIndex(decoded: DecodedLine, byteOffset: number): number {
        if (byteOffset <= 0) {
            return 0;
        }

        const raw = decoded.raw || Buffer.from(decoded.text, 'utf8');
        if (byteOffset >= raw.length) {
            return decoded.text.length;
        }

        const prefix = raw.subarray(0, byteOffset);
        try {
            return decoded.raw ? iconv.decode(prefix, decoded.encoding).length : prefix.toString('utf8').length;
        } catch (error) {
            console.error(`计算匹配位置失败(${decoded.encoding}):`, error);
            return decoded.text.length;
        }
    }

    // 限制传递到视图的单行长度，避免压缩文件等超长行拖慢渲染
    private static buildDisplayContent(content: string, matchStart: number, matchEnd: number): { content: string; matchStart: number; matchEnd: number } {
        // 过滤行首空白字符，避免缩进把行内容推到右边，匹配位置同步左移
        const leadingWhitespace = content.length - content.trimStart().length;
        if (leadingWhitespace > 0) {
            content = content.slice(leadingWhitespace);
            matchEnd = Math.max(0, matchEnd - leadingWhitespace);
            matchStart = Math.max(0, Math.min(matchStart - leadingWhitespace, matchEnd));
        }

        const maxLength = RipGrepSearch.MAX_LINE_LENGTH;
        if (content.length <= maxLength) {
            return { content, matchStart, matchEnd };
        }

        // 尽量让匹配位置保留在窗口中部
        const before = Math.min(matchStart, Math.floor(maxLength / 4));
        const rawStart = Math.max(0, Math.min(matchStart - before, content.length - maxLength));
        // 不要把 emoji 这类代理对从中间截断，否则会显示成乱码
        const windowStart = RipGrepSearch.alignToCodePointStart(content, rawStart);
        const windowEnd = RipGrepSearch.alignToCodePointEnd(content, Math.min(content.length, rawStart + maxLength));
        const prefix = windowStart > 0 ? '…' : '';
        const suffix = windowEnd < content.length ? '…' : '';

        return {
            content: prefix + content.slice(windowStart, windowEnd) + suffix,
            matchStart: matchStart - windowStart + prefix.length,
            matchEnd: matchEnd - windowStart + prefix.length
        };
    }

    // 起点落在代理对中间时回退一位
    private static alignToCodePointStart(text: string, index: number): number {
        const code = text.charCodeAt(index);
        return index > 0 && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
    }

    // 终点把代理对切成两半时回退一位
    private static alignToCodePointEnd(text: string, index: number): number {
        const code = text.charCodeAt(index - 1);
        return index > 0 && index < text.length && code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
    }

    // 解析 ripgrep 的 --json 输出，避免手工切分路径、行号和行内容
    // 给 rg 用的环境：去掉编辑器自己的配置，避免 Cursor 的配置把全文搜索滤成 0 条
    private ripgrepEnv(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.ELECTRON_NO_ASAR;
        delete env.RIPGREP_CONFIG_PATH;
        env.LANG = 'zh_CN.UTF-8';
        env.LC_ALL = 'zh_CN.UTF-8';
        return env;
    }

    private executeRipGrep(rgArgs: string[], caseSensitive: boolean, matchWholeWord: boolean, searchText: string, searchRoot: string, token?: vscode.CancellationToken, onMatch?: (result: SearchResult) => boolean | void): Promise<{ exitCode: number | null; stdoutBytes: number }> {
        return new Promise<{ exitCode: number | null; stdoutBytes: number }>((resolve, reject) => {
            debugLog(`执行命令: ${this.rgPath} ${rgArgs.join(' ')}`);

            const rg = cp.spawn(this.rgPath, rgArgs, {
                cwd: searchRoot,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                // 不把编辑器进程的环境原样传下去。Cursor 会设置 RIPGREP_CONFIG_PATH，
                // rg 若读了那份配置，关掉全词匹配时可能一条结果都没有
                env: this.ripgrepEnv()
            });

            const stdoutDecoder = new StringDecoder('utf8');
            const stderrDecoder = new StringDecoder('utf8');
            const fallbackRegex = RipGrepSearch.buildSearchRegex(searchText, caseSensitive, matchWholeWord);
            const fileResults: SearchResult[] = [];
            const seenLocations = new Set<string>();
            let buffer = '';
            let errorOutput = '';
            let finished = false;
            let exitCode: number | null = null;
            let stdoutBytes = 0;
            let cancelSubscription: vscode.Disposable | undefined;

            const finish = () => {
                if (finished) {
                    return;
                }
                finished = true;
                cancelSubscription?.dispose();
                resolve({ exitCode, stdoutBytes });
            };

            // 处理一条 --json 事件
            const handleEvent = (rawLine: string) => {
                const trimmedLine = rawLine.trim();
                if (!trimmedLine) {
                    return;
                }

                let event: { type?: string; data?: any };
                try {
                    event = JSON.parse(trimmedLine);
                } catch {
                    // 不完整或异常的 JSON 行直接忽略
                    return;
                }

                if (!event || event.type !== 'match' || !event.data) {
                    return;
                }

                const data = event.data;
                const filePath = RipGrepSearch.decodePath(data.path);
                const lineNumber = typeof data.line_number === 'number' ? data.line_number : undefined;
                if (!filePath || lineNumber === undefined) {
                    return;
                }

                const decodedLine = RipGrepSearch.decodeLines(data.lines, filePath);
                const content = decodedLine.text.replace(/[\r\n]+$/, '');
                const trimmedContent = content.trimStart();
                // 注释行不作为搜索结果，过滤规则按文件类型判断
                if (RipGrepSearch.isCommentLine(filePath, trimmedContent)) {
                    return;
                }

                // 同一个文件的同一行只保留一条结果
                const key = locationKey(filePath, lineNumber - 1);
                if (seenLocations.has(key)) {
                    return;
                }

                const matchRanges = RipGrepSearch.resolveMatchRanges(content, data.submatches, fallbackRegex, decodedLine);
                // 只看被搜索的那几个名字。同一行又读又写时，标出写的那一次
                const chosen = chooseMatchRange(writeDetector, content, matchRanges, filePath);
                if (!chosen) {
                    return;
                }
                seenLocations.add(key);

                const display = RipGrepSearch.buildDisplayContent(content, chosen.start, chosen.end);

                const result: SearchResult = {
                    file: filePath,
                    fileName: path.basename(filePath),
                    line: lineNumber - 1,
                    lineContent: display.content,
                    isWrite: chosen.isWrite,
                    isCall: chosen.isCall,
                    matchStart: display.matchStart,
                    matchEnd: display.matchEnd
                };
                fileResults.push(result);
                // 返回 false 表示结果已经够了，停掉 rg，避免把结果页撑爆
                if (onMatch?.(result) === false) {
                    rg.kill();
                }
            };

            rg.stdout.on('data', (data: Buffer) => {
                stdoutBytes += data.length;
                // --json 输出固定为 UTF-8，用 StringDecoder 处理跨数据块的多字节字符
                buffer += stdoutDecoder.write(data);
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    try {
                        handleEvent(line);
                    } catch (error) {
                        console.error('解析 ripgrep 输出失败:', error);
                    }
                }
            });

            rg.stderr.on('data', (data: Buffer) => {
                errorOutput += stderrDecoder.write(data);
            });

            // 取消搜索时结束 ripgrep 进程，已收集的结果照常返回
            if (token) {
                cancelSubscription = token.onCancellationRequested(() => {
                    rg.kill();
                });
            }

            rg.on('error', (err) => {
                // rg 不存在时给出明确的原因，避免只显示“搜索过程中发生错误”
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    RipGrepSearch.promptToSetRipGrepPath();
                    finish();
                    return;
                }
                console.error(`ripgrep 执行错误: ${err.message}`);
                finished = true;
                cancelSubscription?.dispose();
                reject(err);
            });

            rg.on('close', (code: number | null) => {
                exitCode = code;
                if (errorOutput) {
                    console.error(`ripgrep 错误输出: ${errorOutput}`);
                }

                // 处理最后一段没有以换行结尾的输出
                buffer += stdoutDecoder.end();
                if (buffer.trim()) {
                    try {
                        handleEvent(buffer);
                    } catch (error) {
                        console.error('解析 ripgrep 输出失败:', error);
                    }
                }
                buffer = '';

                // code 1 表示没有找到匹配项，这是正常的；用户取消时 code 为 null
                // 异常退出且一条结果都没有时，要把原因传出去，避免结果页空白还没有任何提示
                if (code !== 0 && code !== 1 && code !== null && fileResults.length === 0) {
                    const message = errorOutput.trim() || `ripgrep 进程退出代码 ${code}`;
                    console.error(message);
                    finished = true;
                    cancelSubscription?.dispose();
                    reject(new Error(message));
                    return;
                }
                if (code !== 0 && code !== 1 && code !== null) {
                    console.error(`ripgrep 进程退出代码 ${code}`);
                }

                finish();
            });
        });
    }

    // 符号名是否就是这次要搜的名字。全词匹配比完整名字，否则比是否包含这段文字
    private symbolNameMatches(symbolName: string, searchText: string, caseSensitive: boolean, matchWholeWord: boolean): boolean {
        const simplified = simplifySymbolName(symbolName) || symbolName.trim();
        const candidates = simplified === symbolName ? [symbolName] : [simplified, symbolName];
        const query = caseSensitive ? searchText : searchText.toLowerCase();
        return candidates.some(candidate => {
            const name = caseSensitive ? candidate : candidate.toLowerCase();
            return matchWholeWord ? name === query : name.includes(query);
        });
    }

    // 排除目录、排除后缀，以及工作区以外的文件。规则和 ripgrep 那一路保持一致
    private isExcludedFile(filePath: string, excludeDirs: string[], excludeExts: string[]): boolean {
        if (!this.isInsideWorkspace(filePath)) {
            return true;
        }
        const parts = filePath.replace(/\\/g, '/').split('/');
        const fileName = (parts[parts.length - 1] || '').toLowerCase();
        if (excludeExts.some(ext => {
            const normalized = ext.trim().toLowerCase();
            return normalized.length > 0 && fileName.endsWith(normalized);
        })) {
            return true;
        }
        const dirNames = [...RipGrepSearch.MANDATORY_EXCLUDE_DIRS, ...excludeDirs];
        return dirNames.some(pattern => this.pathMatchesExclude(parts, pattern));
    }

    private isInsideWorkspace(filePath: string): boolean {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return false;
        }
        const key = pathKey(filePath);
        return folders.some(folder => {
            const root = pathKey(folder.uri.fsPath).replace(/\/+$/, '');
            return key === root || key.startsWith(`${root}/`);
        });
    }

    // 配置里的排除项是目录名或 *.egg-info 这种写法，只拿路径里的目录段来比
    private pathMatchesExclude(parts: string[], pattern: string): boolean {
        if (!pattern) {
            return false;
        }
        const normalized = pattern.replace(/\\/g, '/').replace(/^\*\*\//, '').replace(/\/\*\*$/, '').replace(/\/$/, '');
        if (!normalized || normalized === '*' || normalized === '**') {
            return false;
        }
        const dirParts = parts.slice(0, -1);
        if (normalized.startsWith('*')) {
            const suffix = normalized.slice(1).toLowerCase();
            return suffix.length > 0 && dirParts.some(part => part.toLowerCase().endsWith(suffix));
        }
        const name = normalized.toLowerCase();
        return dirParts.some(part => part.toLowerCase() === name);
    }

    // 用语言服务器的符号数据库查找这个名字的引用。
    // 返回 undefined 表示符号数据库不可用或答不上这次查询，调用方改用 ripgrep。
    private async searchSymbolDatabase(
        searchText: string,
        caseSensitive: boolean,
        matchWholeWord: boolean,
        excludeDirs: string[],
        excludeExts: string[],
        token?: vscode.CancellationToken
    ): Promise<SearchResult[] | undefined> {
        if (token?.isCancellationRequested) {
            return undefined;
        }

        const queried = await withTimeout(
            vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                searchText
            ),
            RipGrepSearch.SYMBOL_QUERY_TIMEOUT_MS
        );
        if (token?.isCancellationRequested) {
            return undefined;
        }
        if (queried.timedOut) {
            debugLog('符号数据库查询超时，改用 ripgrep');
            return undefined;
        }
        if (queried.error) {
            debugLog('符号数据库查询失败，改用 ripgrep', queried.error);
            return undefined;
        }
        // 没有注册符号提供者时，这个命令返回空数组，和“库里没有这个名字”分不开，两种都改用全文搜索
        const symbols = queried.value;
        if (!symbols || symbols.length === 0) {
            debugLog('符号数据库没有返回符号，改用 ripgrep');
            return undefined;
        }

        const seenSymbols = new Set<string>();
        const matched = symbols.filter(symbol => {
            if (!symbol?.name || !symbol.location || symbol.location.uri.scheme !== 'file') {
                return false;
            }
            if (!this.symbolNameMatches(symbol.name, searchText, caseSensitive, matchWholeWord)) {
                return false;
            }
            if (this.isExcludedFile(symbol.location.uri.fsPath, excludeDirs, excludeExts)) {
                return false;
            }
            const loc = symbol.location;
            const key = `${pathKey(loc.uri.fsPath)}:${loc.range.start.line}:${loc.range.start.character}:${symbol.name}`;
            if (seenSymbols.has(key)) {
                return false;
            }
            seenSymbols.add(key);
            return true;
        });

        if (matched.length === 0) {
            debugLog(`符号数据库已响应，但没有与 "${searchText}" 匹配的符号，改用 ripgrep`);
            return undefined;
        }
        if (matched.length > RipGrepSearch.MAX_SYMBOLS_TO_EXPAND) {
            debugLog(`匹配的符号有 ${matched.length} 个，超过 ${RipGrepSearch.MAX_SYMBOLS_TO_EXPAND} 个，改用 ripgrep`);
            return undefined;
        }

        debugLog(`符号数据库命中 ${matched.length} 个符号，开始查找引用`);
        const locations = await this.collectReferenceLocations(matched, excludeDirs, excludeExts, token);
        if (!locations || token?.isCancellationRequested) {
            return undefined;
        }

        const results = await this.locationsToResults(locations, searchText, caseSensitive, matchWholeWord, token);
        if (results.length === 0) {
            debugLog('符号引用没有可显示的结果，改用 ripgrep');
            return undefined;
        }
        debugLog(`符号数据库提供 ${results.length} 条搜索结果`);
        return results;
    }

    // 向引用提供者要每个符号的出现位置。一个都问不到时返回 undefined，改用 ripgrep
    private async collectReferenceLocations(
        symbols: vscode.SymbolInformation[],
        excludeDirs: string[],
        excludeExts: string[],
        token?: vscode.CancellationToken
    ): Promise<vscode.Location[] | undefined> {
        const locations: vscode.Location[] = [];
        const seen = new Set<string>();
        let sawReferences = false;

        const add = (location: vscode.Location): void => {
            if (!location?.uri || location.uri.scheme !== 'file') {
                return;
            }
            const filePath = location.uri.fsPath;
            if (this.isExcludedFile(filePath, excludeDirs, excludeExts)) {
                return;
            }
            const key = `${pathKey(filePath)}:${location.range.start.line}:${location.range.start.character}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            locations.push(location);
        };

        const concurrency = Math.min(4, symbols.length);
        let nextIndex = 0;
        const workers = Array.from({ length: concurrency }, async () => {
            while (nextIndex < symbols.length && !token?.isCancellationRequested) {
                const symbol = symbols[nextIndex++];
                const outcome = await withTimeout(
                    vscode.commands.executeCommand<vscode.Location[]>(
                        'vscode.executeReferenceProvider',
                        symbol.location.uri,
                        symbol.location.range.start
                    ),
                    RipGrepSearch.REFERENCE_QUERY_TIMEOUT_MS
                );
                if (outcome.timedOut || outcome.error || !outcome.value || outcome.value.length === 0) {
                    if (outcome.error) {
                        debugLog(`查找符号引用失败: ${symbol.name}`, outcome.error);
                    }
                    continue;
                }
                sawReferences = true;
                for (const location of outcome.value) {
                    add(location);
                }
            }
        });
        await Promise.all(workers);

        if (token?.isCancellationRequested) {
            return undefined;
        }
        if (!sawReferences) {
            debugLog('符号数据库有这个名字，但没有拿到引用，改用 ripgrep');
            return undefined;
        }
        return locations;
    }

    // 把符号引用转成和 ripgrep 相同的搜索结果：读出那一行，再判断读写
    private async locationsToResults(
        locations: vscode.Location[],
        searchText: string,
        caseSensitive: boolean,
        matchWholeWord: boolean,
        token?: vscode.CancellationToken
    ): Promise<SearchResult[]> {
        const byFile = new Map<string, { uri: vscode.Uri; lines: Map<number, vscode.Range[]> }>();
        for (const location of locations) {
            const filePath = location.uri.fsPath;
            const key = pathKey(filePath);
            let entry = byFile.get(key);
            if (!entry) {
                entry = { uri: location.uri, lines: new Map() };
                byFile.set(key, entry);
            }
            const line = location.range.start.line;
            const ranges = entry.lines.get(line) || [];
            ranges.push(location.range);
            entry.lines.set(line, ranges);
        }

        const results: SearchResult[] = [];
        const regex = RipGrepSearch.buildSearchRegex(searchText, caseSensitive, matchWholeWord);
        for (const entry of byFile.values()) {
            if (token?.isCancellationRequested) {
                break;
            }
            let document: vscode.TextDocument;
            try {
                document = await vscode.workspace.openTextDocument(entry.uri);
            } catch (error) {
                debugLog(`读取符号所在文件失败: ${entry.uri.fsPath}`, error);
                continue;
            }
            const filePath = document.uri.fsPath;
            for (const [line, ranges] of entry.lines) {
                if (line < 0 || line >= document.lineCount) {
                    continue;
                }
                const content = document.lineAt(line).text;
                if (RipGrepSearch.isCommentLine(filePath, content.trimStart())) {
                    continue;
                }
                const matchRanges = this.matchRangesOnLine(content, regex, ranges);
                const chosen = chooseMatchRange(writeDetector, content, matchRanges, filePath);
                if (!chosen) {
                    continue;
                }
                const display = RipGrepSearch.buildDisplayContent(content, chosen.start, chosen.end);
                results.push({
                    file: filePath,
                    fileName: path.basename(filePath),
                    line,
                    lineContent: display.content,
                    isWrite: chosen.isWrite,
                    isCall: chosen.isCall,
                    matchStart: display.matchStart,
                    matchEnd: display.matchEnd
                });
            }
        }
        return results;
    }

    // 优先用这一行里的文字匹配。对不上时再用符号自己标出的范围
    private matchRangesOnLine(content: string, regex: RegExp, symbolRanges: vscode.Range[]): { start: number; end: number }[] {
        const ranges: { start: number; end: number }[] = [];
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            if (match[0].length === 0) {
                regex.lastIndex++;
                continue;
            }
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }
        if (ranges.length > 0) {
            return ranges;
        }
        for (const range of symbolRanges) {
            if (range.end.line !== range.start.line) {
                continue;
            }
            const start = Math.max(0, Math.min(range.start.character, content.length));
            const end = Math.max(start, Math.min(range.end.character, content.length));
            if (end > start) {
                ranges.push({ start, end });
            }
        }
        return ranges;
    }

    public async search(searchText: string, startFilePath?: string, onResults?: (results: SearchResult[], isFinal: boolean) => void, progress?: { report: (msg: { message: string }) => void }, token?: vscode.CancellationToken): Promise<SearchResult[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0 || !searchText.trim()) {
            onResults?.([], true);
            return [];
        }

        // 注意：符号与编码缓存跨搜索复用，通过文件修改时间判断是否过期，这里不再每次搜索都清空

        // 从配置中获取搜索选项和过滤规则
        const config = vscode.workspace.getConfiguration('searchhighlight');
        const caseSensitive = config.get<boolean>('caseSensitive', true);
        const matchWholeWord = config.get<boolean>('matchWholeWord', true);
        const respectGitIgnore = config.get<boolean>('respectGitIgnore', false);
        const excludeDirs = config.get<string[]>('excludePatterns') || [];
        const excludeExts = config.get<string[]>('excludeFileExtensions') || [];

        const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
        const startDir = startFilePath ? path.dirname(startFilePath) : undefined;

        // 全词匹配时先问符号数据库。关掉全词匹配后要找的是任意一段文字，符号库答不了，直接全文搜索
        if (matchWholeWord && !token?.isCancellationRequested) {
            progress?.report({ message: '查询符号数据库' });
            const symbolResults = await this.searchSymbolDatabase(
                searchText,
                caseSensitive,
                matchWholeWord,
                excludeDirs,
                excludeExts,
                token
            );
            if (token?.isCancellationRequested) {
                return [];
            }
            if (symbolResults) {
                await functionResolver.enrichResults(symbolResults, token);
                if (token?.isCancellationRequested) {
                    return [];
                }
                const ranked = this.rankResults(symbolResults, startDir, activeFilePath);
                onResults?.(ranked, true);
                return ranked;
            }
            progress?.report({ message: '改用文本搜索' });
        }

        // 符号数据库不可用时才需要 rg。VS Code、Cursor、Trae 等目录都没有 rg 时，提示设置路径
        if (!this.rgPath || !RipGrepSearch.isExistingFile(this.rgPath)) {
            RipGrepSearch.promptToSetRipGrepPath();
            onResults?.([], true);
            return [];
        }

        // 构建排除目录的 glob 模式
        const excludeArgs = [
            // 版本库元数据目录始终排除，避免 --no-ignore 时去遍历 .git/objects
            ...RipGrepSearch.MANDATORY_EXCLUDE_DIRS.flatMap(dir => [
                '--glob',
                `!**/${dir}`
            ]),
            ...excludeDirs.filter(Boolean).flatMap(dir => [
                '--glob',
                `!${dir.startsWith('**/') ? dir : `**/${dir}`}`
            ]),
            // 添加文件后缀过滤
            ...excludeExts.filter(Boolean).flatMap(ext => [
                '--glob',
                `!**/*${ext}`
            ])
        ];

        // 每次搜索都重新构建的基础参数
        const baseArgs = [
            '--json',
            // 不读 rg 的配置文件。Cursor 会给扩展进程设一份配置，读了它之后关掉全词匹配就可能没有结果
            '--no-config',
            '--hidden',
            ...(respectGitIgnore ? [] : ['--no-ignore']),
            '--fixed-strings',
            ...(matchWholeWord ? ['--word-regexp'] : []),
            ...(caseSensitive ? [] : ['-i']),
            ...excludeArgs
        ];

        const allResults: SearchResult[] = [];
        const seenLocations = new Set<string>();
        let deltaBuffer: SearchResult[] = [];
        let pendingFlush: NodeJS.Timeout | undefined;
        let lastFlushAt = 0;

        // 合并短时间内的新结果后一次性推送，避免结果很多时频繁刷新界面
        const flush = (): void => {
            if (!onResults || deltaBuffer.length === 0) {
                return;
            }
            const delta = deltaBuffer;
            deltaBuffer = [];
            lastFlushAt = Date.now();
            onResults(delta, false);
        };

        const scheduleFlush = (): void => {
            if (!onResults || pendingFlush) {
                return;
            }
            const elapsed = Date.now() - lastFlushAt;
            if (elapsed >= RipGrepSearch.RESULT_FLUSH_INTERVAL) {
                flush();
                return;
            }
            pendingFlush = setTimeout(() => {
                pendingFlush = undefined;
                flush();
            }, RipGrepSearch.RESULT_FLUSH_INTERVAL - elapsed);
        };

        let reachedResultCap = false;
        // 按文件+行号去重，同一行只保留第一条结果。够 500 条就停，避免结果页被撑成空白
        const collect = (result: SearchResult): boolean => {
            const key = locationKey(result.file, result.line);
            if (seenLocations.has(key)) {
                return true;
            }
            if (allResults.length >= RipGrepSearch.MAX_VIEW_RESULTS) {
                if (!reachedResultCap) {
                    reachedResultCap = true;
                    progress?.report({ message: `结果较多，只显示前 ${RipGrepSearch.MAX_VIEW_RESULTS} 条` });
                }
                return false;
            }
            seenLocations.add(key);
            allResults.push(result);
            deltaBuffer.push(result);
            scheduleFlush();
            return true;
        };

        // 单次扫描：每个工作区根目录只搜一遍
        // 之前“先搜当前目录、再搜整个工作区”会让当前目录被扫描两次，大项目上开销翻倍
        const roots = workspaceFolders.map(folder => folder.uri.fsPath);
        progress?.report({ message: roots.length > 1 ? `搜索 ${roots.length} 个工作区目录` : '搜索工作区' });

        const settled = await Promise.allSettled(roots.map(async root => {
            const rgArgs = [...baseArgs, '--', searchText, root];
            await this.executeRipGrep(rgArgs, caseSensitive, matchWholeWord, searchText, root, token, collect);
        }));

        if (pendingFlush) {
            clearTimeout(pendingFlush);
            pendingFlush = undefined;
        }
        flush();

        // 单个目录失败不影响其它目录已经得到的结果
        const failures: string[] = [];
        for (const item of settled) {
            if (item.status === 'rejected') {
                console.error('部分目录搜索失败:', item.reason);
                failures.push(item.reason instanceof Error ? item.reason.message : String(item.reason));
            }
        }

        // 函数名在结果推送之后再补齐，避免语言服务解析阻塞首屏显示
        await functionResolver.enrichResults(allResults, token);

        const finalResults = this.rankResults(allResults, startDir, activeFilePath);
        // 一个结果都没有，而且搜索过程失败了：必须告诉用户，不能只留一个空白页
        if (failures.length > 0 && finalResults.length === 0 && !token?.isCancellationRequested) {
            vscode.window.showErrorMessage(`搜索失败：${failures[0]}`);
        }
        onResults?.(finalResults, true);
        return finalResults;
    }

    // 结果排序：当前文件最前，其次是当前文件所在目录内的结果
    private rankResults(results: SearchResult[], startDir?: string, activeFilePath?: string): SearchResult[] {
        if (!startDir && !activeFilePath) {
            return results;
        }

        const activeKey = activeFilePath ? pathKey(activeFilePath) : undefined;
        const dirPrefix = startDir ? `${pathKey(startDir).replace(/\/+$/, '')}/` : undefined;
        const rankOf = (result: SearchResult): number => {
            const key = pathKey(result.file);
            if (activeKey && key === activeKey) {
                return 0;
            }
            if (dirPrefix && key.startsWith(dirPrefix)) {
                return 1;
            }
            return 2;
        };

        // sort 是稳定的，同档次内保持原有顺序
        return [...results].sort((a, b) => rankOf(a) - rankOf(b));
    }
}

// 创建 RipGrep 搜索实例
const ripGrepSearch = new RipGrepSearch();

class SearchResultsProvider implements vscode.WebviewViewProvider {
    private static readonly HISTORY_KEY = 'searchhighlight.searchHistory';
    private static readonly HISTORY_LIMIT = 30;

    private _view?: vscode.WebviewView;
    // 页面脚本发出 ready 之后才算真正能显示。在这之前发消息，Cursor 会把结果页清成空白
    private _viewReady = false;
    private _readyWaiters: Array<() => void> = [];
    private _pendingFocus = false;
    // 上次把页面写进视图的时间。刚写完不要立刻再写，否则页面会一直重开
    private _htmlAppliedAt = 0;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;
    // 最近搜索在数组最前面，相同内容只保留一条
    private _searchHistory: string[] = [];
    private _currentSearchResults?: { results: SearchResult[]; searchText: string; searchId: number; };
    private _searchText = '';
    private _lastSearchStartFile?: string;
    // 当前搜索序号，用于丢弃过期搜索的结果，避免旧结果覆盖新结果
    private _searchId = 0;
    // 正在进行中的搜索，开始新搜索时会取消它
    private _activeSearchCts?: vscode.CancellationTokenSource;
    // 高亮样式按颜色复用，避免每次跳转都创建、销毁 decoration type
    private _decorationTypes = new Map<string, vscode.TextEditorDecorationType>();
    // 当前已应用高亮的编辑器与样式
    private _decoratedEditor?: vscode.TextEditor;
    private _decoratedTypes: vscode.TextEditorDecorationType[] = [];
    // 已高亮的文档，用于避免跳转过程中的编辑器切换事件把高亮清掉
    private _highlightedDocKey?: string;
    private _editorChangeListener?: vscode.Disposable;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
        const stored = context.globalState.get<unknown>(SearchResultsProvider.HISTORY_KEY, []);
        this._searchHistory = Array.isArray(stored)
            ? stored.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : [];
    }

    private _getSearchOptions() {
        const config = vscode.workspace.getConfiguration('searchhighlight');
        return {
            caseSensitive: config.get<boolean>('caseSensitive', true),
            matchWholeWord: config.get<boolean>('matchWholeWord', true)
        };
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        this._viewReady = false;
        webviewView.onDidDispose(() => {
            if (this._view === webviewView) {
                this._view = undefined;
                this._viewReady = false;
            }
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // 先写出页面，保证至少能看到搜索框。监听放在赋值之前，避免页面加载过快时 ready 丢失
        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'jump':
                    const document = await vscode.workspace.openTextDocument(message.file);
                    const editor = await vscode.window.showTextDocument(document);
                    const position = new vscode.Position(message.line, 0);
                    editor.selection = new vscode.Selection(position, position);
                    editor.revealRange(
                        new vscode.Range(position, position),
                        vscode.TextEditorRevealType.InCenter
                    );
                    this.highlightSearchText(editor, this._searchText);
                    break;
                case 'updateOption':
                    const config = vscode.workspace.getConfiguration('searchhighlight');
                    // 配置变更后由 onDidChangeConfiguration 统一触发重新搜索，避免重复搜索
                    await config.update(message.option, message.value, vscode.ConfigurationTarget.Global);
                    break;
                case 'ready':
                    this._markViewReady();
                    this._postSearchHistory();
                    if (this._pendingFocus) {
                        this._pendingFocus = false;
                        this._view?.webview.postMessage({ type: 'focusSearch' });
                    }
                    // 快捷键会一边打开结果页一边搜索。搜索先完成时，结果消息会丢，这里等页面准备好再补发一次
                    if (this._currentSearchResults) {
                        this._postResults(
                            this._currentSearchResults.results,
                            this._currentSearchResults.searchText,
                            'final',
                            this._currentSearchResults.searchId
                        );
                    }
                    break;
                case 'search':
                    // 处理来自输入框的搜索请求
                    const searchText = message.text;
                    if (searchText) {
                        const currentFile = vscode.window.activeTextEditor?.document.uri.fsPath;
                        await this.searchWithProgress(searchText, currentFile);
                    }
                    break;
                case 'addFileExtFilter':
                    // 处理添加文件扩展名到过滤列表
                    const extension = message.extension;
                    if (extension) {
                        const config = vscode.workspace.getConfiguration('searchhighlight');
                        const excludeExts = config.get<string[]>('excludeFileExtensions') || [];

                        // 检查是否已存在该扩展名
                        if (!excludeExts.includes(extension)) {
                            excludeExts.push(extension);
                            await config.update('excludeFileExtensions', excludeExts, vscode.ConfigurationTarget.Global);
                            vscode.window.showInformationMessage(`已将 ${extension} 文件类型添加到搜索忽略列表`);
                            // 配置变更后由 onDidChangeConfiguration 统一触发重新搜索，这里不再重复搜索
                        } else {
                            vscode.window.showInformationMessage(`${extension} 文件类型已在搜索忽略列表中`);
                        }
                    }
                    break;
                case 'copyToClipboard':
                    // 处理复制到剪贴板
                    if (message.text) {
                        await vscode.env.clipboard.writeText(message.text);
                        vscode.window.showInformationMessage(`已复制到剪贴板: ${message.text}`);
                    }
                    break;
                case 'openInExplorer':
                    // 处理在资源管理器中打开文件
                    if (message.filePath) {
                        const filePath = message.filePath;
                        try {
                            // 使用 VS Code 内部命令在资源管理器中打开文件
                            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
                        } catch (error) {
                            console.error('在资源管理器中打开文件失败:', error);
                            vscode.window.showErrorMessage('无法在资源管理器中打开文件');
                        }
                    }
                    break;
            }
        });

        this._applyHtml(webviewView);
    }

    // 把结果页写进视图。写失败时也要留一句说明，不能留下空白
    private _applyHtml(webviewView: vscode.WebviewView): void {
        this._htmlAppliedAt = Date.now();
        try {
            webviewView.webview.html = this._getHtmlForWebview();
        } catch (error) {
            console.error('加载搜索结果页失败:', error);
            const message = error instanceof Error ? error.message : String(error);
            webviewView.webview.html = `<!DOCTYPE html><html><body style="padding:12px;font-family:sans-serif;"><p>结果页加载失败：${message}</p></body></html>`;
        }
    }

    // 页面过了半秒还是空白，再画一次。刚画完的不要立刻重画
    public ensurePage(): void {
        if (!this._view || this._viewReady) {
            return;
        }
        if (Date.now() - this._htmlAppliedAt < 500) {
            return;
        }
        this._applyHtml(this._view);
    }

    public showResults(results: SearchResult[], searchText: string) {
        this._postResults(results, searchText, 'final', this._searchId);
    }

    // 把结果推送给视图：delta 用于搜索过程中的增量追加，final 用最终结果整体刷新
    private _postResults(results: SearchResult[], searchText: string, mode: 'delta' | 'final', searchId: number) {
        const config = vscode.workspace.getConfiguration('searchhighlight');
        this._searchText = searchText;
        // 先记下来。结果页还没创建好时也要留着，等它发来 ready 再补发
        if (mode === 'final') {
            this._currentSearchResults = { results, searchText, searchId };
        }

        // 页面还没准备好时先不发。提前发消息会让 Cursor 把整页清成空白，结果留到 ready 再补发
        if (!this._view || !this._viewReady) {
            return;
        }

        this._view.webview.postMessage({
            type: 'results',
            results,
            searchText, // 将搜索文本传递给 webview 用于显示在输入框
            colors: {
                read: config.get<string>('colors.read'),
                write: config.get<string>('colors.write'),
                call: config.get<string>('colors.call')
            },
            searchOptions: this._getSearchOptions(),
            mode,
            searchId
        });
    }

    // 聚焦搜索框。不要调用 show()，结果页正在打开时再 show，Cursor 会把页面清成空白
    public focusSearchInput() {
        if (this._view && this._viewReady) {
            this._view.webview.postMessage({ type: 'focusSearch' });
            return;
        }
        this._pendingFocus = true;
    }

    // 等结果页真正画出来。超时后继续搜索，结果会在页面准备好时补上
    public whenViewReady(timeoutMs = 2000): Promise<void> {
        if (this._viewReady && this._view) {
            return Promise.resolve();
        }
        return new Promise(resolve => {
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            this._readyWaiters.push(finish);
            if (this._viewReady && this._view) {
                finish();
            }
        });
    }

    private _markViewReady(): void {
        this._viewReady = true;
        const waiters = this._readyWaiters.splice(0);
        for (const waiter of waiters) {
            waiter();
        }
    }

    private _postSearching(searchText: string, searchId: number): void {
        if (!this._view || !this._viewReady) {
            return;
        }
        this._view.webview.postMessage({
            type: 'searching',
            searchText,
            searchId
        });
    }

    // 记住这次搜索：最近的放最前，重复的旧记录删掉
    private _rememberSearch(searchText: string): void {
        const text = searchText.trim();
        if (!text) {
            return;
        }
        this._searchHistory = [
            text,
            ...this._searchHistory.filter(item => item !== text)
        ].slice(0, SearchResultsProvider.HISTORY_LIMIT);
        void this._context.globalState.update(SearchResultsProvider.HISTORY_KEY, this._searchHistory);
        this._postSearchHistory();
    }

    private _postSearchHistory(): void {
        if (!this._view || !this._viewReady) {
            return;
        }
        this._view.webview.postMessage({
            type: 'searchHistory',
            history: this._searchHistory
        });
    }

    // 执行一次带进度提示的搜索并显示结果
    public async searchWithProgress(searchText: string, startFilePath?: string): Promise<void> {
        this._searchText = searchText;
        this._lastSearchStartFile = startFilePath;
        this._rememberSearch(searchText);

        const searchId = ++this._searchId;
        // 取消上一次仍在进行的搜索，避免两次搜索的结果互相覆盖
        this._activeSearchCts?.cancel();
        this._activeSearchCts?.dispose();
        const cts = new vscode.CancellationTokenSource();
        this._activeSearchCts = cts;
        const isStale = () => searchId !== this._searchId;

        // 先等结果页画出来再搜。半秒后还是空白，就再画一次
        await this.whenViewReady(700);
        if (!this._viewReady && !isStale()) {
            this.ensurePage();
            await this.whenViewReady(1500);
        }
        if (isStale()) {
            cts.dispose();
            return;
        }
        this._postSearching(searchText, searchId);

        // 不用可取消的进度条。Cursor 里那种进度一出现就会把正在跑的 ripgrep 停掉，
        // 关掉全词匹配时搜索只靠 ripgrep，结果就会变成 0 条
        let status = vscode.window.setStatusBarMessage(`搜索 "${searchText}"`);
        const progress = {
            report: ({ message }: { message: string }) => {
                status.dispose();
                status = vscode.window.setStatusBarMessage(`搜索 "${searchText}"：${message}`);
            }
        };
        try {
            try {
                await ripGrepSearch.search(searchText, startFilePath, (results, isFinal) => {
                    // 丢弃过期搜索的结果
                    if (isStale()) {
                        return;
                    }
                    this._postResults(results, searchText, isFinal ? 'final' : 'delta', searchId);
                }, progress, cts.token);
            } catch (error) {
                if (!isStale()) {
                    console.error('搜索过程中发生错误:', error);
                    vscode.window.showErrorMessage('搜索过程中发生错误');
                }
            }
        } finally {
            status.dispose();
            if (this._activeSearchCts === cts) {
                this._activeSearchCts = undefined;
            }
            cts.dispose();
        }
    }

    public updateCurrentResults() {
        if (this._currentSearchResults) {
            this.showResults(this._currentSearchResults.results, this._currentSearchResults.searchText);
        }
    }

    // 配置变化后按当前条件重新搜索，重算读写属性
    public async rerunCurrentSearch(): Promise<void> {
        if (!this._currentSearchResults) {
            return;
        }
        await this.searchWithProgress(this._currentSearchResults.searchText, this._lastSearchStartFile);
    }

    private _getHtmlForWebview() {
        const webviewPath = path.join(this._extensionUri.fsPath, 'src', 'webview.html');
        let html = fs.readFileSync(webviewPath, { encoding: 'utf8' });

        // 注入 nonce 与 webview 资源来源，满足 VS Code 的内容安全策略要求
        // 只用十六进制，避免 nonce 里的 + / = 把内容安全策略写坏，导致整页空白
        const nonce = crypto.randomBytes(16).toString('hex');
        html = html.replace(/\{\{nonce\}\}/g, nonce);
        html = html.replace(/\{\{cspSource\}\}/g, this._view ? this._view.webview.cspSource : '');
        return html;
    }

    private highlightSearchText(editor: vscode.TextEditor, searchText: string) {
        if (!searchText) {
            return;
        }

        // 清除之前的高亮
        this.clearDecorations();

        // 获取配置
        const config = vscode.workspace.getConfiguration('searchhighlight');
        const readColor = config.get<string>('colors.read', '#FFEB3B');
        const writeColor = config.get<string>('colors.write', '#FF5252');
        const callColor = config.get<string>('colors.call', 'rgba(184, 78, 0, 0.55)');
        const { caseSensitive, matchWholeWord } = this._getSearchOptions();

        // 读写操作和函数调用的高亮样式按颜色复用，避免每次跳转都重新创建
        const readDecorationType = this.getDecorationType(readColor);
        const writeDecorationType = this.getDecorationType(writeColor);
        const callDecorationType = this.getDecorationType(callColor);

        // 与搜索使用同一套全词规则，中文等非 ASCII 标识符也能对上边界
        const searchRegex = RipGrepSearch.buildSearchRegex(searchText, caseSensitive, matchWholeWord);

        // 遍历文档中的每一行
        const readDecorations: vscode.DecorationOptions[] = [];
        const writeDecorations: vscode.DecorationOptions[] = [];
        const callDecorations: vscode.DecorationOptions[] = [];

        for (let i = 0; i < editor.document.lineCount; i++) {
            const lineText = editor.document.lineAt(i).text;
            // 区分大小写时，绝大多数行都不包含搜索词，用原生 indexOf 先筛掉，避免逐行跑正则
            if (caseSensitive && lineText.indexOf(searchText) === -1) {
                continue;
            }

            searchRegex.lastIndex = 0;
            let match;
            while ((match = searchRegex.exec(lineText)) !== null) {
                // 空匹配会让 lastIndex 不前进导致死循环，直接跳过
                if (match[0].length === 0) {
                    searchRegex.lastIndex++;
                    continue;
                }

                const startPos = new vscode.Position(i, match.index);
                const endPos = new vscode.Position(i, match.index + match[0].length);
                const range = new vscode.Range(startPos, endPos);

                // 根据匹配项前后的文本判断是写操作还是读操作
                const afterText = lineText.substring(match.index + match[0].length);
                const beforeText = lineText.substring(0, match.index);
                const isWrite = writeDetector.isWriteOperation(afterText, beforeText, editor.document.uri.fsPath);
                const isCall = !isWrite && isFunctionCall(beforeText, afterText, editor.document.uri.fsPath);

                const decoration = { range };
                if (isWrite) {
                    writeDecorations.push(decoration);
                } else if (isCall) {
                    callDecorations.push(decoration);
                } else {
                    readDecorations.push(decoration);
                }
            }
        }

        // 应用高亮
        if (readDecorations.length > 0 || writeDecorations.length > 0 || callDecorations.length > 0) {
            try {
                editor.setDecorations(readDecorationType, readDecorations);
                editor.setDecorations(writeDecorationType, writeDecorations);
                editor.setDecorations(callDecorationType, callDecorations);
            } catch (error) {
                // 编辑器已经关闭时忽略
                debugLog('应用高亮失败:', error);
                return;
            }

            this._decoratedEditor = editor;
            this._decoratedTypes = [readDecorationType, writeDecorationType, callDecorationType];
            this._highlightedDocKey = pathKey(editor.document.uri.fsPath);
            // 设置上下文变量，标记有高亮存在
            vscode.commands.executeCommand('setContext', 'searchHighlightActive', true);
        }

        // 文档切换时清除高亮，监听只注册一次，避免每次跳转都累积监听器
        if (!this._editorChangeListener) {
            this._editorChangeListener = vscode.window.onDidChangeActiveTextEditor(next => {
                // 跳转本身也会触发编辑器切换，切换到正在高亮的文档时保留高亮
                if (next && this._highlightedDocKey && pathKey(next.document.uri.fsPath) === this._highlightedDocKey) {
                    return;
                }
                this.clearDecorations();
            });
        }
    }

    // 按颜色复用高亮样式
    private getDecorationType(color: string): vscode.TextEditorDecorationType {
        let decorationType = this._decorationTypes.get(color);
        if (!decorationType) {
            decorationType = vscode.window.createTextEditorDecorationType({ backgroundColor: color });
            this._decorationTypes.set(color, decorationType);
        }
        return decorationType;
    }

    public clearDecorations() {
        const editor = this._decoratedEditor;
        const types = this._decoratedTypes;
        this._decoratedEditor = undefined;
        this._decoratedTypes = [];
        this._highlightedDocKey = undefined;

        if (!editor || types.length === 0) {
            return;
        }

        // 只清空装饰内容，复用的 decoration type 留到 dispose 时再释放
        for (const type of types) {
            try {
                editor.setDecorations(type, []);
            } catch {
                // 编辑器已关闭时忽略
            }
        }
        // 清除上下文变量，取消高亮状态
        vscode.commands.executeCommand('setContext', 'searchHighlightActive', false);
    }

    public dispose() {
        this.clearDecorations();
        this._editorChangeListener?.dispose();
        this._editorChangeListener = undefined;
        this._activeSearchCts?.cancel();
        this._activeSearchCts?.dispose();
        this._activeSearchCts = undefined;
        this._decorationTypes.forEach(type => type.dispose());
        this._decorationTypes.clear();
    }
}

export function activate(context: vscode.ExtensionContext) {
    debugLog('SearchHighlight 插件开始激活...');

    try {
        debugEnabled = vscode.workspace.getConfiguration('searchhighlight').get<boolean>('debug', false);

        debugLog('正在创建 SearchResultsProvider...');
        const searchResultsProvider = new SearchResultsProvider(context.extensionUri, context);
        debugLog('正在注册 WebviewViewProvider...');
        const viewDisposable = vscode.window.registerWebviewViewProvider(
            'searchHighlightResults',
            searchResultsProvider,
            {
                // 不要保留隐藏时的页面。Cursor 会把保留下来的旧页面恢复成一片空白，而且不再重新画
                webviewOptions: {
                    retainContextWhenHidden: false
                }
            }
        );
        context.subscriptions.push(viewDisposable);
        context.subscriptions.push(searchResultsProvider);
        debugLog('WebviewViewProvider 注册成功');

        // 修改确保视图可见的函数
        async function ensureViewIsVisible() {
            debugLog('正在确保视图可见...');
            try {
                // 打开侧边栏里的结果页。不要用 focus 命令，Cursor 里那个命令有时会打开一片空白
                await vscode.commands.executeCommand('workbench.view.extension.search-highlight');
                debugLog('视图已显示');
            } catch (error) {
                console.error('显示视图时出错:', error);
            }
        }

        // 注册 focus 命令
        debugLog('正在注册 focus 命令...');
        context.subscriptions.push(
            vscode.commands.registerCommand('searchhighlight.focus', () => {
                debugLog('执行 focus 命令...');
                return ensureViewIsVisible();
            })
        );
        debugLog('focus 命令注册成功');

        // 注册重新加载写操作检测规则命令
        context.subscriptions.push(
            vscode.commands.registerCommand('searchhighlight.reloadPatterns', () => {
                reloadWritePatterns();
                // 手动重载时同时清掉符号与编码缓存，避免缓存内容过期后无法刷新
                functionResolver.clearCache();
                RipGrepSearch.clearEncodingCache();
                void searchResultsProvider.rerunCurrentSearch();
                vscode.window.showInformationMessage('已重新加载写操作检测规则');
            })
        );

        // 监听配置变更
        debugLog('正在注册配置变更监听器...');
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (!e.affectsConfiguration('searchhighlight')) {
                    return;
                }

                if (e.affectsConfiguration('searchhighlight.debug')) {
                    debugEnabled = vscode.workspace.getConfiguration('searchhighlight').get<boolean>('debug', false);
                }

                if (e.affectsConfiguration('searchhighlight.patterns')) {
                    reloadWritePatterns();
                }

                if (e.affectsConfiguration('searchhighlight.ripgrepPath')) {
                    ripGrepSearch.refreshRipGrepPath();
                }

                // 这些配置会影响搜索结果或读写属性，需要重新搜索
                const searchKeys = ['patterns', 'caseSensitive', 'matchWholeWord',
                    'excludePatterns', 'excludeFileExtensions', 'respectGitIgnore', 'ripgrepPath'];
                const changedSearchKeys = searchKeys.filter(key => e.affectsConfiguration(`searchhighlight.${key}`));
                if (changedSearchKeys.length > 0) {
                    debugLog('搜索相关配置变更，重新执行搜索');
                    void searchResultsProvider.rerunCurrentSearch();
                    // 大小写、全词按钮会连续点，按钮状态和结果刷新已经是反馈，不再每次弹提示
                    const onlyToggle = changedSearchKeys.every(key => key === 'caseSensitive' || key === 'matchWholeWord');
                    if (!onlyToggle) {
                        vscode.window.showInformationMessage('搜索高亮配置已更新');
                    }
                } else if (e.affectsConfiguration('searchhighlight.colors')) {
                    debugLog('更新高亮颜色配置');
                    searchResultsProvider.updateCurrentResults();
                    vscode.window.showInformationMessage('搜索高亮配置已更新');
                }
            })
        );
        debugLog('配置变更监听器注册成功');

        // 注册clearHighlight命令
        debugLog('正在注册清除高亮命令...');
        context.subscriptions.push(
            vscode.commands.registerCommand('searchhighlight.clearHighlight', async () => {
                debugLog('执行清除高亮命令...');
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    searchResultsProvider.clearDecorations();
                }
            })
        );

        debugLog('正在注册主搜索命令...');
        let disposable = vscode.commands.registerCommand('searchhighlight.searchAndHighlight', async () => {
            debugLog('执行搜索命令...');
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                debugLog('没有活动的编辑器');
                // 打开搜索面板并聚焦到输入框
                await ensureViewIsVisible();
                searchResultsProvider.focusSearchInput();
                return;
            }

            const selection = editor.selection;
            let searchText = editor.document.getText(selection);

            // 如果没有选中文本，则获取光标所在位置的单词
            if (!searchText) {
                debugLog('没有选中文本，尝试获取光标所在单词...');
                const position = editor.selection.active;
                const wordRange = editor.document.getWordRangeAtPosition(position);
                if (wordRange) {
                    searchText = editor.document.getText(wordRange);
                    debugLog('获取到光标所在单词:', searchText);
                }
            }

            if (!searchText) {
                debugLog('没有找到可搜索的文本');
                // 打开搜索面板并聚焦到输入框，不再显示错误消息
                await ensureViewIsVisible();
                searchResultsProvider.focusSearchInput();
                return;
            }

            debugLog('搜索文本:', searchText);

            try {
                // 确保搜索结果视图是可见的
                debugLog('正在显示搜索结果视图...');
                await ensureViewIsVisible();
                searchResultsProvider.ensurePage();

                // 显示进度提示并执行搜索
                debugLog('开始执行搜索...');
                await searchResultsProvider.searchWithProgress(searchText, editor.document.uri.fsPath);
            } catch (error) {
                console.error('命令执行过程中发生错误:', error);
                vscode.window.showErrorMessage('执行搜索命令时发生错误');
            }
        });

        context.subscriptions.push(disposable);
        debugLog('主搜索命令注册成功');
        debugLog('SearchHighlight 插件激活完成');

    } catch (error) {
        console.error('插件激活过程中发生错误:', error);
        throw error; // 重新抛出错误以便 VS Code 可以捕获并显示
    }
}

export function deactivate() {
    // 搜索结果视图随 context.subscriptions 一起释放
}
