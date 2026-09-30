/**
 * 写操作检测
 *
 * 判断依据是「匹配到的标识符之后、同一行内」的文本，覆盖以下写操作写法：
 *   1. 直接赋值：x = 1、x += 1、x++、x := 1、x <- v
 *   2. 左值后缀赋值：x[0] = 1、obj.field = 1、p->field = 1、a, b = f()、x: int = 1
 *   3. 会修改自身的成员方法：xs.append(1)、xs.Add(1)、list.push_back(1)、obj.setX(1)
 *   4. 会修改第一个实参的函数：append(xs, v)、memcpy(dst, src)
 *
 * 命中任意一条即按写操作处理，其余一律按读操作处理。纯文本启发式无法判断的写法
 * （例如 std::sort(v.begin(), v.end()) 通过迭代器修改容器）会退化成读操作。
 */

import * as path from 'path';

// 一组写操作检测规则。配置里可以配置多组（common、go、python ...），检测时合并使用
export interface WritePatternGroup {
    // 赋值运算符，例如 =、+=、:=
    operators?: string[];
    // 会修改接收者的成员方法名，例如 append、add
    methods?: string[];
    // 会修改第一个实参的函数名，例如 append(xs, v)、memcpy(dst, src)
    functions?: string[];
    // 不能当成赋值的运算符，例如 ==、=>；内置的比较运算符始终生效
    excludeOperators?: string[];
}

export interface WritePatterns {
    [key: string]: WritePatternGroup;
}

// 比较、箭头类运算符永远不能当成赋值，即使用户配置里漏写
const BUILT_IN_EXCLUDE_OPERATORS = ['===', '!==', '==', '!=', '=>', '=~', '>=', '<='];

// 运算符前面最多允许出现的左值后缀长度，避免在超长行上做无谓扫描
const MAX_LVALUE_SCAN_LENGTH = 96;

// 成员链最多解析的层级，防止异常输入导致的长循环
const MAX_MEMBER_CHAIN_DEPTH = 32;

// Unicode 标识符，支持中文等非 ASCII 变量名
const IDENTIFIER_RE = /[\p{L}\p{Nl}$_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}$_]*/uy;

// 类型注解：x: int = 1、x: List[int] = []、x: str | None = None、x: number[] = []
const TYPE_ANNOTATION_RE = /^:\s*[\p{L}\p{Nl}$_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}$_.]*(?:\s*<[^<>]*>)?(?:\s*\[\s*\])?(?:\s*[|&]\s*[\p{L}\p{Nl}$_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}$_.]*)*/u;

// 以 # 作为行注释的语言，其它语言（如 C/C++ 的 #include）不能按注释处理
const HASH_COMMENT_EXTENSIONS = new Set([
    '.py', '.pyi', '.sh', '.bash', '.zsh', '.fish', '.rb', '.rake', '.yml', '.yaml',
    '.toml', '.ini', '.cfg', '.conf', '.properties', '.pl', '.pm', '.r', '.jl', '.ps1',
    '.psm1', '.tcl', '.coffee', '.nim', '.ex', '.exs', '.nix', '.mk', '.cmake', '.gd'
]);

// 没有扩展名但同样用 # 作注释的文件
const HASH_COMMENT_FILES = new Set([
    'makefile', 'dockerfile', 'rakefile', 'gemfile', 'procfile', 'brewfile',
    'cmakelists.txt', '.gitignore', '.gitattributes', '.dockerignore', '.env', '.editorconfig'
]);

// 以 -- 作为行注释的语言，这些语言里 -- 不是运算符
const DASH_COMMENT_EXTENSIONS = new Set([
    '.sql', '.lua', '.hs', '.lhs', '.elm', '.ada', '.adb', '.ads', '.vhd', '.vhdl'
]);

// <- 只在下列语言里是赋值（Haskell/F#/Elixir）或通道发送（Go），
// 其它语言里 x<-1 其实是 x < -1 的比较
const LEFT_ARROW_EXTENSIONS = new Set([
    '.go', '.hs', '.lhs', '.fs', '.fsi', '.fsx', '.ml', '.mli', '.sml',
    '.erl', '.hrl', '.ex', '.exs'
]);

// 判断文件是否使用 # 作为行注释（搜索结果过滤与写操作检测共用）
export function isHashCommentFile(filePath: string): boolean {
    const baseName = path.basename(filePath).toLowerCase();
    if (HASH_COMMENT_FILES.has(baseName)) {
        return true;
    }
    return HASH_COMMENT_EXTENSIONS.has(path.extname(baseName));
}

// 当前文件的行注释前缀，用于识别注释里的「假赋值」
function lineCommentPrefixes(filePath: string): string[] {
    if (!filePath) {
        return ['//'];
    }
    if (isHashCommentFile(filePath)) {
        return ['#'];
    }
    return DASH_COMMENT_EXTENSIONS.has(path.extname(path.basename(filePath).toLowerCase()))
        ? ['--']
        : ['//'];
}

// 判断当前文件是否支持 <- 运算符
function supportsLeftArrow(filePath: string): boolean {
    if (!filePath) {
        return true;
    }
    return LEFT_ARROW_EXTENSIONS.has(path.extname(path.basename(filePath).toLowerCase()));
}

function isWhitespace(char: string): boolean {
    return /\s/.test(char);
}

function isIdentifierChar(char: string): boolean {
    return /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}$_]/u.test(char);
}

// 读取 start 处的标识符，返回结束位置，失败返回 -1
function readIdentifier(text: string, start: number): number {
    IDENTIFIER_RE.lastIndex = start;
    const match = IDENTIFIER_RE.exec(text);
    return match ? start + match[0].length : -1;
}

function skipSpaces(text: string, start: number): number {
    let i = start;
    while (i < text.length && isWhitespace(text[i])) {
        i++;
    }
    return i;
}

// 读取一个字符串字面量，返回结束位置；未闭合时返回 text.length + 1
function skipStringLiteral(text: string, start: number): number {
    const quote = text[start];
    let i = start + 1;
    while (i < text.length) {
        if (text[i] === '\\') {
            i += 2;
            continue;
        }
        if (text[i] === quote) {
            return i + 1;
        }
        i++;
    }
    return text.length + 1;
}

// 跳过[start] 处的成对括号（内部允许嵌套与字符串字面量），返回结束位置，失败返回 -1
function skipBalancedGroup(text: string, start: number, open: string, close: string): number {
    let depth = 0;
    let i = start;
    while (i < text.length) {
        const char = text[i];
        if (char === '"' || char === '\'' || char === '`') {
            const end = skipStringLiteral(text, i);
            if (end > text.length) {
                return -1;
            }
            i = end;
            continue;
        }
        if (char === open) {
            depth++;
        } else if (char === close) {
            depth--;
            if (depth === 0) {
                return i + 1;
            }
        }
        i++;
    }
    return -1;
}

// 匹配点之前的文本是否停在字符串字面量或行注释里（这类位置上的标识符不参与读写判断）
function scanPrefix(text: string, commentPrefixes: string[]): { inString: boolean; inComment: boolean } {
    let i = 0;
    while (i < text.length) {
        for (const prefix of commentPrefixes) {
            if (text.startsWith(prefix, i)) {
                return { inString: false, inComment: true };
            }
        }
        const char = text[i];
        if (char === '"' || char === '\'' || char === '`') {
            const end = skipStringLiteral(text, i);
            if (end > text.length) {
                return { inString: true, inComment: false };
            }
            i = end;
            continue;
        }
        i++;
    }
    return { inString: false, inComment: false };
}

// 匹配点前面未被闭合的圆括号数量：大于 0 说明处在实参列表里
function openParenDepth(text: string): number {
    let depth = 0;
    let i = 0;
    while (i < text.length) {
        const char = text[i];
        if (char === '"' || char === '\'' || char === '`') {
            const end = skipStringLiteral(text, i);
            i = end > text.length ? text.length : end;
            continue;
        }
        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth = Math.max(0, depth - 1);
        }
        i++;
    }
    return depth;
}

// 读取成员访问运算符：.、?.、->、::，返回运算符长度，不是成员访问返回 0
function readAccessOperator(text: string, start: number): number {
    if (text.startsWith('?.', start)) {
        return 2;
    }
    if (text.startsWith('->', start)) {
        return 2;
    }
    if (text.startsWith('::', start)) {
        return 2;
    }
    return text[start] === '.' ? 1 : 0;
}

// 逗号/星号之后才允许出现裸标识符，用于跨过解构与多重赋值的其它目标
function isLValueContinuation(segment: string, allowComma: boolean): boolean {
    let i = 0;
    let allowIdentifier = false;
    while (i < segment.length) {
        const char = segment[i];
        if (isWhitespace(char)) {
            i++;
            continue;
        }
        if (char === '[') {
            const end = skipBalancedGroup(segment, i, '[', ']');
            if (end < 0) {
                return false;
            }
            i = end;
            allowIdentifier = false;
            continue;
        }
        // 解构：let [a] = arr、let {a} = obj、let (a) = f()
        if (char === ']' || char === '}' || char === ')') {
            i++;
            allowIdentifier = false;
            continue;
        }
        // TS 非空断言：只允许 x!.y 这种后面还接着成员访问的写法，避免把 x != y 当成左值
        if (char === '!') {
            const next = skipSpaces(segment, i + 1);
            if (segment[next] !== '.' && segment[next] !== '[') {
                return false;
            }
            i++;
            allowIdentifier = true;
            continue;
        }
        // 指针、引用与解构里的 rest 标记
        if (char === '*' || char === '&') {
            i++;
            allowIdentifier = true;
            continue;
        }
        if (char === ',') {
            if (!allowComma) {
                return false;
            }
            i++;
            allowIdentifier = true;
            continue;
        }
        // 解构里的 ...rest / ..rest
        if (segment.startsWith('...', i)) {
            i += 3;
            allowIdentifier = true;
            continue;
        }
        const accessLength = readAccessOperator(segment, i);
        if (accessLength > 0) {
            const end = readIdentifier(segment, i + accessLength);
            if (end < 0) {
                return false;
            }
            i = end;
            allowIdentifier = false;
            continue;
        }
        // 类型注解：x: int = 1、x: List[int] = []、x: str | None = None
        if (char === ':') {
            const match = TYPE_ANNOTATION_RE.exec(segment.slice(i));
            if (!match) {
                return false;
            }
            i += match[0].length;
            allowIdentifier = false;
            continue;
        }
        const identifierEnd = allowIdentifier ? readIdentifier(segment, i) : -1;
        if (identifierEnd > i) {
            i = identifierEnd;
            allowIdentifier = false;
            continue;
        }
        return false;
    }
    return true;
}

// 读取紧跟在入参圆括号前面的函数名，例如 "memcpy(dst, " -> "memcpy"
function readTrailingCallName(beforeText: string): string | undefined {
    let i = beforeText.length - 1;
    while (i >= 0 && isWhitespace(beforeText[i])) {
        i--;
    }
    if (i < 0 || beforeText[i] !== '(') {
        return undefined;
    }
    i--;
    while (i >= 0 && isWhitespace(beforeText[i])) {
        i--;
    }
    const end = i + 1;
    while (i >= 0 && isIdentifierChar(beforeText[i])) {
        i--;
    }
    const name = beforeText.slice(i + 1, end);
    return name || undefined;
}

function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function sortByLengthDesc(values: string[]): string[] {
    // 长运算符优先，保证 +=、++、??= 不会被 = 提前命中
    return [...values].sort((a, b) => b.length - a.length);
}

export class WriteOperationDetector {
    private operators: string[] = [];
    private excludeOperators: string[] = [];
    private methods = new Set<string>();
    private functions = new Set<string>();

    // 合并多组配置：既保留 common，也保留用户按语言新增的分组
    public setPatterns(patterns: WritePatterns | undefined | null): void {
        const groups = Object.values(patterns || {}).filter((group): group is WritePatternGroup => !!group);
        this.operators = sortByLengthDesc(unique(groups.flatMap(group => group.operators || [])));
        this.excludeOperators = sortByLengthDesc(unique([
            ...BUILT_IN_EXCLUDE_OPERATORS,
            ...groups.flatMap(group => group.excludeOperators || [])
        ]));
        this.methods = new Set(groups.flatMap(group => group.methods || []).map(name => name.toLowerCase()));
        this.functions = new Set(groups.flatMap(group => group.functions || []).map(name => name.toLowerCase()));
    }

    /**
     * 判断匹配到的标识符是否为写操作
     * @param afterText 同一行内、匹配标识符之后的文本
     * @param beforeText 同一行内、匹配标识符之前的文本
     * @param filePath 文件路径，用于区分行注释写法
     */
    public isWriteOperation(afterText: string, beforeText = '', filePath = ''): boolean {
        const text = afterText.trimStart();
        if (!text) {
            return false;
        }

        const commentPrefixes = lineCommentPrefixes(filePath);
        const prefix = scanPrefix(beforeText, commentPrefixes);
        // 字符串字面量或注释里的标识符不参与读写判断
        if (prefix.inString || prefix.inComment) {
            return false;
        }

        // 作为可变函数的第一个实参传入：append(xs, v)、memcpy(dst, src)
        if (this.isMutatedFirstArgument(text, beforeText)) {
            return true;
        }

        // 会修改自身的成员方法：xs.append(v)、xs.Add(v)、obj.setX(v)
        if (this.hasMutatingMemberCall(text)) {
            return true;
        }

        // 左值后缀 + 赋值运算符
        return this.hasAssignmentOperator(text, beforeText, filePath, commentPrefixes);
    }

    private isMutatedFirstArgument(text: string, beforeText: string): boolean {
        if (this.functions.size === 0) {
            return false;
        }
        const functionName = readTrailingCallName(beforeText);
        if (!functionName || !this.functions.has(functionName.toLowerCase())) {
            return false;
        }

        // 只承认第一个实参（含它的成员、下标后缀），第二个实参之后一律不算
        const limit = Math.min(text.length, MAX_LVALUE_SCAN_LENGTH);
        for (let i = 0; i <= limit; i++) {
            if (text[i] === ',' || text[i] === ')') {
                return isLValueContinuation(text.slice(0, i), false);
            }
        }
        return false;
    }

    private hasMutatingMemberCall(text: string): boolean {
        let i = 0;
        for (let depth = 0; depth < MAX_MEMBER_CHAIN_DEPTH; depth++) {
            i = skipSpaces(text, i);
            const accessLength = readAccessOperator(text, i);
            if (accessLength === 0) {
                return false;
            }
            const nameStart = i + accessLength;
            const nameEnd = readIdentifier(text, nameStart);
            if (nameEnd < 0) {
                return false;
            }
            if (this.isMutatingMethodName(text.slice(nameStart, nameEnd))) {
                return true;
            }
            i = skipSpaces(text, nameEnd);
            if (text[i] === '[') {
                const end = skipBalancedGroup(text, i, '[', ']');
                if (end < 0) {
                    return false;
                }
                i = end;
                continue;
            }
            // 链上还有成员就继续看，遇到 ( 等调用边界即停止
            if (readAccessOperator(text, i) === 0) {
                return false;
            }
        }
        return false;
    }

    private isMutatingMethodName(name: string): boolean {
        const lower = name.toLowerCase();
        if (this.methods.has(lower)) {
            return true;
        }
        // CamelCase 变体：setValue/addItem/removeAll 等价于 set/add/remove
        const upperIndex = name.search(/[A-Z]/);
        if (upperIndex > 0 && this.methods.has(name.slice(0, upperIndex).toLowerCase())) {
            return true;
        }
        return false;
    }

    private hasAssignmentOperator(text: string, beforeText: string, filePath: string, commentPrefixes: string[]): boolean {
        // 实参列表里的逗号可能属于默认参数或调用参数，不能当成多重赋值
        const allowComma = openParenDepth(beforeText) === 0;
        const limit = Math.min(text.length, MAX_LVALUE_SCAN_LENGTH);

        let i = 0;
        while (i <= limit) {
            const start = skipSpaces(text, i);
            if (start > limit) {
                return false;
            }

            // 只在真正出现赋值运算符的位置停下，避免 -> 、generics 里的 > 被当成比较运算符
            const operator = this.operators.find(candidate => text.startsWith(candidate, start));
            if (operator) {
                const matched = this.matchOperatorAt(text, start);
                // 比较、箭头类运算符按读操作处理
                if (matched?.excluded) {
                    return false;
                }
                // // 在 C 系语言里是行注释（例如 x //= 2），-- 在 SQL 里是注释
                if (commentPrefixes.some(prefix => text.startsWith(prefix, start))) {
                    return false;
                }
                // <- 在 C 系语言里其实是 x < -1 的比较
                if (operator === '<-' && !supportsLeftArrow(filePath)) {
                    return false;
                }
                return isLValueContinuation(text.slice(0, start), allowComma);
            }
            i = start + 1;
        }
        return false;
    }

    /**
     * 取 start 处最长的运算符。长度相同时排除项优先，
     * 避免配置里的 < 覆盖 <<=、= 覆盖 => 这类多字符运算符。
     */
    private matchOperatorAt(text: string, start: number): { value: string; excluded: boolean } | undefined {
        let best: { value: string; excluded: boolean } | undefined;
        const consider = (value: string, excluded: boolean): void => {
            if (!text.startsWith(value, start)) {
                return;
            }
            if (!best || value.length > best.value.length || (value.length === best.value.length && excluded && !best.excluded)) {
                best = { value, excluded };
            }
        };
        for (const value of this.operators) {
            consider(value, false);
        }
        for (const value of this.excludeOperators) {
            consider(value, true);
        }
        return best;
    }
}
