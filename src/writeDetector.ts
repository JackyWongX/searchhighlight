/**
 * 写操作检测
 *
 * 判断依据是「匹配到的标识符之后、同一行内」的文本，覆盖以下写操作写法：
 *   1. 直接赋值：x = 1、x += 1、x++、x := 1、x <- v
 *   2. 这个名字自己就是被赋值的左值：x[0] = 1、x: int = 1、a, b = f()
 *      成员赋值写的是最后那个名字：obj.field = 1 写 field，p->field = 1 写 field。
 *      前面的 obj、p 只是被读来定位，不算写
 *   3. 会修改自身的成员方法：xs.append(1)、xs.Add(1)、list.push_back(1)、obj.setX(1)
 *      必须真的是调用。只认紧挨着这个名字的方法。a.b.append(v) 写的是 b，不是 a
 *      obj.set = 1 是给 set 赋值，obj 不算写
 *   4. 会修改第一个实参的自由函数：append(xs, v)、memcpy(dst, src)
 *      实参若还带着成员，写的是最后那个名字：strcpy(p->date, src) 写 date，不写 p
 *      成员调用（list.append(item)、p->insert(it)）不走这条规则，避免和 methods 重名时把实参误判成写
 *   5. 前缀自增：++x、--x。++p->field 按优先级写的是 field，不是 p
 *   6. 循环变量和部分绑定：for x in、for (x of、for (x :、out x、import a as b
 *   *x = 1 里 x 只被读取，真正改的是它指向的内容；int *x = 1 里的 x 仍是声明赋值
 *
 * 命中任意一条即按写操作处理，其余一律按读操作处理。字符串、行注释和块注释里的同名文本不算写。
 * 纯文本启发式无法判断的写法（例如 std::sort(v.begin(), v.end()) 通过迭代器修改容器）会退化成读操作。
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

// 类型名，含限定名里的一段（std::string 的 string）
const TYPE_IDENT = '[\\p{L}\\p{Nl}$_][\\p{L}\\p{Nl}\\p{Nd}\\p{Mn}\\p{Mc}\\p{Pc}$_.]*';
// 引用/指针前缀：&str、&'a str、&'a mut str、*const T
const TYPE_REF = `(?:[&*]\\s*(?:'${TYPE_IDENT}\\s+)?(?:mut\\s+|const\\s+)?)`;
const TYPE_ATOM = `${TYPE_REF}*${TYPE_IDENT}(?:\\s*<[^<>]*>)?(?:\\s*\\[\\s*\\])?`;
// 类型注解：x: int = 1、x: List[int] = []、x: str | None = None、let x: &'a str = "hi"
const TYPE_ANNOTATION_RE = new RegExp(`^:\\s*${TYPE_ATOM}(?:\\s*[|&]\\s*${TYPE_ATOM})*`, 'u');

// 声明关键字，用来区分「let x: int = 1」和「label: x = 1」
const ANNOTATION_INTRODUCER_RE = /(?:^|[^\p{L}\p{N}_$])(?:let|const|var|val|mut|public|private|protected|readonly|static|final|export|declare|abstract|override|def)$/u;

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
    '.erl', '.hrl', '.ex', '.exs', '.r', '.scala'
]);

// 判断文件是否使用 # 作为行注释（搜索结果过滤与写操作检测共用）
export function isHashCommentFile(filePath: string): boolean {
    const baseName = path.basename(filePath).toLowerCase();
    if (HASH_COMMENT_FILES.has(baseName)) {
        return true;
    }
    return HASH_COMMENT_EXTENSIONS.has(path.extname(baseName));
}

// 全词匹配用 Unicode 字母、数字、连接符分词，和 ripgrep --word-regexp 一致，而不是 JS 的 ASCII \b
export function buildIdentifierSearchRegex(searchText: string, caseSensitive: boolean, matchWholeWord: boolean): RegExp {
    const flags = caseSensitive ? 'gu' : 'giu';
    const escapedSearchText = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = matchWholeWord
        ? `(?<![\\p{L}\\p{M}\\p{N}\\p{Pc}])${escapedSearchText}(?![\\p{L}\\p{M}\\p{N}\\p{Pc}])`
        : escapedSearchText;
    return new RegExp(pattern, flags);
}

// 判断文件是否使用 -- 作为行注释（SQL、Lua、Haskell 等）
export function isDashCommentFile(filePath: string): boolean {
    if (!filePath) {
        return false;
    }
    return DASH_COMMENT_EXTENSIONS.has(path.extname(path.basename(filePath).toLowerCase()));
}

function isPythonFile(filePath: string): boolean {
    const ext = path.extname(path.basename(filePath).toLowerCase());
    return ext === '.py' || ext === '.pyi';
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

// 跳过引号字符串。单引号没有配对闭合时不当成字符串（Rust 生命周期 'a、英文撇号）
function skipQuoted(text: string, start: number): number {
    const end = skipStringLiteral(text, start);
    if (text[start] === '\'' && end > text.length) {
        return start + 1;
    }
    return end;
}

// 跳过[start] 处的成对括号（内部允许嵌套与字符串字面量），返回结束位置，失败返回 -1
function skipBalancedGroup(text: string, start: number, open: string, close: string): number {
    let depth = 0;
    let i = start;
    while (i < text.length) {
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            if (end < 0) {
                return -1;
            }
            i = end + 2;
            continue;
        }
        const char = text[i];
        if (char === '"' || char === '\'' || char === '`') {
            const end = skipQuoted(text, i);
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

// 匹配点之前是否停在字符串、行注释或未闭合的块注释里（这类位置上的标识符不参与读写判断）
function scanPrefix(text: string, commentPrefixes: string[]): { inString: boolean; inComment: boolean } {
    let i = 0;
    while (i < text.length) {
        for (const prefix of commentPrefixes) {
            if (text.startsWith(prefix, i)) {
                return { inString: false, inComment: true };
            }
        }
        // 同一行里的 /* */：没闭合说明匹配点还在注释里，闭合了就跳过继续看后面的代码
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            if (end < 0) {
                return { inString: false, inComment: true };
            }
            i = end + 2;
            continue;
        }
        const char = text[i];
        if (char === '"' || char === '\'' || char === '`') {
            const end = skipQuoted(text, i);
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
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            if (end < 0) {
                break;
            }
            i = end + 2;
            continue;
        }
        const char = text[i];
        if (char === '"' || char === '\'' || char === '`') {
            const end = skipQuoted(text, i);
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

// 左值后缀是否合法，以及当前这个名字是不是「被赋值的那一个」
// terminal 为 false 表示中间又经过了 . / -> / ::，写操作属于后面的名字
function analyzeLValue(segment: string, allowComma: boolean): { valid: boolean; terminal: boolean } {
    let i = 0;
    let allowIdentifier = false;
    let onFirstTarget = true;
    let hopped = false;
    const invalid = { valid: false, terminal: false };
    while (i < segment.length) {
        const char = segment[i];
        if (isWhitespace(char)) {
            i++;
            continue;
        }
        if (char === '[') {
            const end = skipBalancedGroup(segment, i, '[', ']');
            if (end < 0) {
                return invalid;
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
                return invalid;
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
                return invalid;
            }
            i++;
            allowIdentifier = true;
            onFirstTarget = false;
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
                return invalid;
            }
            // obj.field、p->field、Foo::value：写的是后面的名字，不是当前这个
            if (onFirstTarget) {
                hopped = true;
            }
            i = end;
            allowIdentifier = false;
            continue;
        }
        // 类型注解：x: int = 1、x: List[int] = []、x: str | None = None
        if (char === ':') {
            const match = TYPE_ANNOTATION_RE.exec(segment.slice(i));
            if (!match) {
                return invalid;
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
        return invalid;
    }
    return { valid: true, terminal: !hopped };
}

// 往左跳过一个标识符，返回它的起点；前面不是标识符时返回 -1
function readIdentifierBackward(text: string, endExclusive: number): number {
    let i = endExclusive - 1;
    if (i < 0 || !isIdentifierChar(text[i])) {
        return -1;
    }
    while (i >= 0 && isIdentifierChar(text[i])) {
        i--;
    }
    const start = i + 1;
    // 数字开头的不是标识符
    if (/[\p{Nd}]/u.test(text[start])) {
        return -1;
    }
    return start;
}

// 以 endIndex 结尾的成员访问运算符长度。.、?.、->、::
function readAccessOperatorEndingAt(text: string, endIndex: number): number {
    if (endIndex < 0) {
        return 0;
    }
    if (text[endIndex] === '>' && endIndex > 0 && text[endIndex - 1] === '-') {
        return 2;
    }
    if (text[endIndex] === '.' && endIndex > 0 && text[endIndex - 1] === '?') {
        return 2;
    }
    if (text[endIndex] === ':' && endIndex > 0 && text[endIndex - 1] === ':') {
        return 2;
    }
    return text[endIndex] === '.' ? 1 : 0;
}

// 成员运算符左边的对象：xs[i].field 要先跳过下标，再跳过 xs。返回这个对象之前的位置
function peelAccessBase(beforeText: string, operatorEnd: number, accessLength: number): number {
    let k = operatorEnd - accessLength;
    while (k >= 0 && isWhitespace(beforeText[k])) {
        k--;
    }
    while (k >= 0 && beforeText[k] === ']') {
        const openIndex = skipBalancedBackward(beforeText, k, '[', ']');
        if (openIndex < 0) {
            return -1;
        }
        k = openIndex - 1;
        while (k >= 0 && isWhitespace(beforeText[k])) {
            k--;
        }
    }
    if (k >= 0 && beforeText[k] === '!') {
        k--;
        while (k >= 0 && isWhitespace(beforeText[k])) {
            k--;
        }
    }
    const identStart = readIdentifierBackward(beforeText, k + 1);
    if (identStart < 0) {
        return -1;
    }
    return identStart - 1;
}

// 从右往左找到与 closeIndex 配对的开括号，失败返回 -1
function skipBalancedBackward(text: string, closeIndex: number, open: string, close: string): number {
    let depth = 0;
    for (let i = closeIndex; i >= 0; i--) {
        const char = text[i];
        if (char === close) {
            depth++;
        } else if (char === open) {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

// 匹配点往左剥掉成员和下标，找到仍包着它的函数调用。
// 中间出现逗号说明已经不是第一个实参，返回 undefined
function findEnclosingFirstArgCall(beforeText: string): { name: string; kind: 'free' | 'member' | 'qualified' } | undefined {
    let i = beforeText.length;
    for (let step = 0; step < MAX_MEMBER_CHAIN_DEPTH; step++) {
        let j = i - 1;
        while (j >= 0 && isWhitespace(beforeText[j])) {
            j--;
        }
        if (j < 0) {
            return undefined;
        }

        const accessLength = readAccessOperatorEndingAt(beforeText, j);
        if (accessLength > 0) {
            const beforeBase = peelAccessBase(beforeText, j, accessLength);
            if (beforeBase < -1) {
                return undefined;
            }
            // 下一轮从对象名字的前一个字符继续看，才能找到 strcpy(
            i = beforeBase + 1;
            continue;
        }

        const char = beforeText[j];
        if (char === ']' || char === ')') {
            const open = char === ']' ? '[' : '(';
            const openIndex = skipBalancedBackward(beforeText, j, open, char);
            if (openIndex < 0) {
                return undefined;
            }
            i = openIndex;
            continue;
        }
        // 取地址、解引用：memcpy(&buf, src)、strcpy(*p, src)，名字本身仍是被写的那个
        if (char === '&' || char === '*' || char === '!') {
            i = j;
            continue;
        }
        if (char === '(') {
            const call = readTrailingCall(beforeText.slice(0, j + 1));
            if (call) {
                return call;
            }
            // (char*)p->date 这种分组或转型括号，继续往左找真正的调用
            i = j;
            continue;
        }
        return undefined;
    }
    return undefined;
}

// 类型正文里允许出现的字符（不含单独的冒号，:: 另作处理）
function isTypeFragmentChar(char: string): boolean {
    return /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}$_.<>\[\]|&*',?()]/u.test(char);
}

// 冒号前面是声明（let/const、参数括号等），或当前文件是 Python 的变量注解
function hasAnnotationIntroducer(prefix: string, filePath: string): boolean {
    const trimmed = prefix.trimEnd();
    // case FOO: x = 1 里，FOO 后面的 x 是语句，不是类型名
    if (/(?:^|[^\p{L}\p{N}_$])case$/u.test(trimmed)) {
        return false;
    }
    if (isPythonFile(filePath)) {
        return true;
    }
    if (!trimmed) {
        return false;
    }
    if ('([{,'.includes(trimmed[trimmed.length - 1])) {
        return true;
    }
    return ANNOTATION_INTRODUCER_RE.test(trimmed);
}

// 最内层未闭合的 { 是解构或对象字面量，而不是 if/for 的语句块
function isPatternBrace(beforeText: string): boolean {
    const stack: number[] = [];
    for (let i = 0; i < beforeText.length; i++) {
        const char = beforeText[i];
        if (char === '"' || char === '\'' || char === '`') {
            const end = skipQuoted(beforeText, i);
            if (end > beforeText.length) {
                break;
            }
            i = end - 1;
            continue;
        }
        if (beforeText.startsWith('/*', i)) {
            const end = beforeText.indexOf('*/', i + 2);
            if (end < 0) {
                break;
            }
            i = end + 1;
            continue;
        }
        if (char === '{') {
            stack.push(i);
        } else if (char === '}' && stack.length > 0) {
            stack.pop();
        }
    }
    if (stack.length === 0) {
        return false;
    }
    let j = stack[stack.length - 1] - 1;
    while (j >= 0 && isWhitespace(beforeText[j])) {
        j--;
    }
    // 行首的 { 是语句块，解构都会写成 const { 或 ({ 
    if (j < 0) {
        return false;
    }
    if ('(=,['.includes(beforeText[j])) {
        return true;
    }
    const identStart = readIdentifierBackward(beforeText, j + 1);
    if (identStart < 0) {
        return false;
    }
    const word = beforeText.slice(identStart, j + 1);
    return /^(?:const|let|var|val|import|public|private|protected|readonly|static)$/u.test(word);
}

// {a: b} = obj 里 a 是被读的键，b 才是被写入的名字。x: int = 1 里的 x 不是这种键
function isDestructureRenameKey(beforeText: string, afterText: string): boolean {
    if (!isPatternBrace(beforeText)) {
        return false;
    }
    return /^:\s*[\p{L}\p{Nl}$_]/u.test(afterText);
}

// 赋值号左边如果只是 *x 或 *p->field，改的是指向的内容，这个名字本身没被赋值
// int *x = 1 前面还有类型名，x 仍然是被声明赋值的那个名字
function assignmentIsThroughDereference(beforeText: string): boolean {
    let i = beforeText.length - 1;
    for (let step = 0; step < MAX_MEMBER_CHAIN_DEPTH; step++) {
        while (i >= 0 && isWhitespace(beforeText[i])) {
            i--;
        }
        if (i < 0) {
            return false;
        }
        if (beforeText[i] === '*') {
            while (i >= 0 && (beforeText[i] === '*' || isWhitespace(beforeText[i]) || beforeText[i] === '(')) {
                i--;
            }
            while (i >= 0 && isWhitespace(beforeText[i])) {
                i--;
            }
            return !(i >= 0 && isIdentifierChar(beforeText[i]));
        }
        if (beforeText[i] === '(' || beforeText[i] === '!') {
            i--;
            continue;
        }
        const accessLength = readAccessOperatorEndingAt(beforeText, i);
        if (accessLength > 0) {
            const beforeBase = peelAccessBase(beforeText, i, accessLength);
            if (beforeBase < -1) {
                return false;
            }
            i = beforeBase;
            continue;
        }
        if (beforeText[i] === ']') {
            const openIndex = skipBalancedBackward(beforeText, i, '[', ']');
            if (openIndex < 0) {
                return false;
            }
            i = openIndex - 1;
            continue;
        }
        return false;
    }
    return false;
}

// ++p->field 的自增落在 field 上。后面又接了别的名字时，当前这个名字不是目标
function forwardsToAnotherIdentifier(afterText: string): boolean {
    let i = 0;
    while (i < afterText.length) {
        i = skipSpaces(afterText, i);
        if (afterText[i] === '[') {
            const end = skipBalancedGroup(afterText, i, '[', ']');
            if (end < 0) {
                return false;
            }
            i = end;
            continue;
        }
        const accessLength = readAccessOperator(afterText, i);
        if (accessLength === 0) {
            return false;
        }
        return readIdentifier(afterText, i + accessLength) > 0;
    }
    return false;
}

// 前缀 ++x / --x。++*x 改的是指向的内容；*++x 改的是 x 自己
function isPrefixUpdateTarget(beforeText: string, afterText: string): boolean {
    if (forwardsToAnotherIdentifier(afterText)) {
        return false;
    }
    let i = beforeText.length - 1;
    let sawDeref = false;
    for (let step = 0; step < MAX_MEMBER_CHAIN_DEPTH; step++) {
        while (i >= 0 && isWhitespace(beforeText[i])) {
            i--;
        }
        if (i < 0) {
            return false;
        }
        if ((i > 0 && beforeText[i] === '+' && beforeText[i - 1] === '+')
            || (i > 0 && beforeText[i] === '-' && beforeText[i - 1] === '-')) {
            return !sawDeref;
        }
        if (beforeText[i] === '*' || beforeText[i] === '&') {
            sawDeref = true;
            i--;
            continue;
        }
        if (beforeText[i] === '(' || beforeText[i] === '!') {
            i--;
            continue;
        }
        const accessLength = readAccessOperatorEndingAt(beforeText, i);
        if (accessLength > 0) {
            const beforeBase = peelAccessBase(beforeText, i, accessLength);
            if (beforeBase < -1) {
                return false;
            }
            i = beforeBase;
            continue;
        }
        if (beforeText[i] === ']') {
            const openIndex = skipBalancedBackward(beforeText, i, '[', ']');
            if (openIndex < 0) {
                return false;
            }
            i = openIndex - 1;
            continue;
        }
        return false;
    }
    return false;
}

// C# 的 out / ref 参数会被调用方写回
function isOutputArgument(beforeText: string): boolean {
    return /(?:^|[^\p{L}\p{N}_$])(?:out|ref)(?:\s+(?:var|readonly))?\s*$/u.test(beforeText);
}

// for x in、for (x of、for (auto x : 里的循环变量每次都会被赋值
function isLoopBinding(beforeText: string, afterText: string): boolean {
    if (!/(?:^|[^\p{L}\p{N}_$])(?:for|foreach)\b/u.test(beforeText)) {
        return false;
    }
    const after = afterText.trimStart();
    if (/^(?:in|of)\b/u.test(after)) {
        return true;
    }
    // for x in items: 末尾的冒号属于语句，不是 C++/Java 的 range-for
    if (/(?:^|[^\p{L}\p{N}_$])(?:in|of)\b/u.test(beforeText)) {
        return false;
    }
    return after.startsWith(':') && !after.startsWith('::') && !after.startsWith(':=');
}

// import a as b、except E as e、with f as g、foreach ($a as $b)。x as Type 这种断言不算
function isAliasBinding(beforeText: string): boolean {
    // PHP 的 $value 和 as 之间隔着一个 $
    const endsWithAs = /(?:^|[^\p{L}\p{N}_$])as\s+\$?\s*$/u.test(beforeText);
    const foreachValue = /(?:^|[^\p{L}\p{N}_$])as\s+\$?[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}_]*\s*=>\s*\$?\s*$/u.test(beforeText);
    if (!endsWithAs && !foreachValue) {
        return false;
    }
    return /(?:^|[^\p{L}\p{N}_$])(?:import|except|with|foreach)\b/u.test(beforeText);
}

// 当前标识符落在类型注解里，而不是被赋值的那个名字。例如 let x: int = 1 里的 int
function isInsideTypeAnnotation(beforeText: string, filePath: string): boolean {
    // {a: b} = obj 里，冒号后面的 b 是被写入的绑定，不是类型名
    if (isPatternBrace(beforeText) && /:\s*$/u.test(beforeText)) {
        return false;
    }
    let i = beforeText.length - 1;
    while (i >= 0) {
        if (isWhitespace(beforeText[i])) {
            i--;
            continue;
        }
        // std::string 里的 :: 属于类型名，不是注解冒号
        if (beforeText[i] === ':' && i > 0 && beforeText[i - 1] === ':') {
            i -= 2;
            continue;
        }
        if (isTypeFragmentChar(beforeText[i])) {
            i--;
            continue;
        }
        break;
    }
    while (i >= 0 && isWhitespace(beforeText[i])) {
        i--;
    }
    if (i < 0 || beforeText[i] !== ':' || (i > 0 && beforeText[i - 1] === ':')) {
        return false;
    }
    i--;
    while (i >= 0 && isWhitespace(beforeText[i])) {
        i--;
    }
    const bindingEnd = i + 1;
    while (i >= 0 && isIdentifierChar(beforeText[i])) {
        i--;
    }
    if (i + 1 === bindingEnd) {
        return false;
    }
    return hasAnnotationIntroducer(beforeText.slice(0, i + 1), filePath);
}

// case FOO: 里的 FOO 是分支标签，不是被赋值的变量
function isCaseLabel(beforeText: string, afterText: string): boolean {
    if (!afterText.startsWith(':')) {
        return false;
    }
    return /(?:^|[^\p{L}\p{N}_$])case\s*$/u.test(beforeText);
}

// 读取紧挨在「(」前面的函数名，并区分自由函数、成员调用和 :: 限定名
function readTrailingCall(beforeText: string): { name: string; kind: 'free' | 'member' | 'qualified' } | undefined {
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
    if (!name) {
        return undefined;
    }
    let prev = i;
    while (prev >= 0 && isWhitespace(beforeText[prev])) {
        prev--;
    }
    // . 与 ?. 都落在「.」上；-> 是成员调用。:: 是限定名，留给调用方决定
    if (prev >= 0 && beforeText[prev] === '.') {
        return { name, kind: 'member' };
    }
    if (prev > 0 && beforeText[prev] === '>' && beforeText[prev - 1] === '-') {
        return { name, kind: 'member' };
    }
    if (prev > 0 && beforeText[prev] === ':' && beforeText[prev - 1] === ':') {
        return { name, kind: 'qualified' };
    }
    return { name, kind: 'free' };
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
        const commentPrefixes = lineCommentPrefixes(filePath);
        const prefix = scanPrefix(beforeText, commentPrefixes);
        // 字符串字面量或注释里的标识符不参与读写判断
        if (prefix.inString || prefix.inComment) {
            return false;
        }

        // case 标签、类型注解里的类型名不是写操作
        if (isCaseLabel(beforeText, text) || isInsideTypeAnnotation(beforeText, filePath)) {
            return false;
        }

        // {a: b} = obj 里 a 是键，不是被赋值的变量
        if (isDestructureRenameKey(beforeText, text)) {
            return false;
        }

        // 这些写法和后面有没有文本无关：++x、out x、for x in
        if (isPrefixUpdateTarget(beforeText, text)
            || isOutputArgument(beforeText)
            || isLoopBinding(beforeText, text)
            || isAliasBinding(beforeText)) {
            return true;
        }

        if (!text) {
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
        // strcpy(p->date, src) 里，date 左边是 -> 而不是 (，也要能找回 strcpy
        const call = findEnclosingFirstArgCall(beforeText);
        if (!call || !this.functions.has(call.name.toLowerCase())) {
            return false;
        }
        // list.append(item)、p->insert(pos) 修改的是接收者，不是括号里的第一个实参
        if (call.kind === 'member') {
            return false;
        }
        // 和成员方法重名的限定调用（Foo::insert）也不按自由函数处理。
        // std::memcpy 不在方法表里，仍然把第一个实参当成写
        if (call.kind === 'qualified' && this.methods.has(call.name.toLowerCase())) {
            return false;
        }

        // 只承认第一个实参末尾那个名字。strcpy(p->date, src) 写 date，不写 p
        const limit = Math.min(text.length, MAX_LVALUE_SCAN_LENGTH);
        for (let i = 0; i <= limit; i++) {
            if (text[i] === ',' || text[i] === ')') {
                const lvalue = analyzeLValue(text.slice(0, i), false);
                return lvalue.valid && lvalue.terminal;
            }
        }
        return false;
    }

    private hasMutatingMemberCall(text: string): boolean {
        let i = 0;
        // 下标仍属于当前这个名字：xs[i].push_back(v) 改的是 xs
        for (let depth = 0; depth < MAX_MEMBER_CHAIN_DEPTH && text[skipSpaces(text, i)] === '['; depth++) {
            const start = skipSpaces(text, i);
            const end = skipBalancedGroup(text, start, '[', ']');
            if (end < 0) {
                return false;
            }
            i = end;
        }
        i = skipSpaces(text, i);
        const accessLength = readAccessOperator(text, i);
        if (accessLength === 0) {
            return false;
        }
        const nameStart = i + accessLength;
        const nameEnd = readIdentifier(text, nameStart);
        if (nameEnd < 0 || !this.isMutatingMethodName(text.slice(nameStart, nameEnd))) {
            return false;
        }
        // obj.set = 1 是在给属性赋值，不是调用 set。必须看到调用括号
        return this.isMethodInvocation(text, nameEnd);
    }

    private isMethodInvocation(text: string, nameEnd: number): boolean {
        let i = skipSpaces(text, nameEnd);
        // xs.append<T>(v)、obj.setValue<int>(v)
        if (text[i] === '<') {
            const end = skipBalancedGroup(text, i, '<', '>');
            if (end < 0) {
                return false;
            }
            i = skipSpaces(text, end);
        }
        return text[i] === '(';
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
                // 成员链后面的赋值不属于当前这个名字：p->field = 1 写的是 field
                const lvalue = analyzeLValue(text.slice(0, start), allowComma);
                if (!lvalue.valid || !lvalue.terminal) {
                    return false;
                }
                // *x = 1、*p->field = 1 改的是指向的内容。后缀 ++ 优先级更高，*x++ 仍然算写 x
                if (operator !== '++' && operator !== '--' && assignmentIsThroughDereference(beforeText)) {
                    return false;
                }
                return true;
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

// 引入函数定义的关键字。这些词紧挨在名字前面时，后面的括号是定义，不是调用
const DEFINITION_KEYWORDS = new Set([
    'function', 'func', 'fn', 'fun', 'def', 'sub', 'procedure', 'method',
    'macro', 'subroutine', 'defun', 'defn', 'define'
]);

// 声明修饰符。紧挨在名字前面时，这一处是声明，例如 public foo(、static foo(
const DECLARATION_MODIFIERS = new Set([
    'async', 'export', 'public', 'private', 'protected', 'static', 'virtual',
    'override', 'final', 'inline', 'constexpr', 'consteval', 'constinit',
    'friend', 'extern', 'explicit', 'abstract', 'sealed', 'internal', 'pub',
    'native', 'synchronized', 'open', 'partial', 'unsafe', 'mutable', 'volatile',
    'register', 'unsigned', 'signed', 'short', 'long', 'typename', 'declare',
    'readonly', 'required', 'suspend', 'tailrec', 'external', 'expect', 'actual',
    'crate', 'fileprivate', 'operator', 'shared', 'module', 'const', 'mut', 'global'
]);

// 常见返回类型。紧挨在名字前面时按声明处理，例如 void foo(、int *foo(
const TYPE_KEYWORDS = new Set([
    'void', 'int', 'char', 'bool', 'boolean', 'float', 'double', 'byte', 'sbyte',
    'uint', 'ulong', 'ushort', 'string', 'object', 'auto', 'var', 'val', 'any',
    'never', 'unknown', 'dynamic', 'self', 'size_t', 'wchar_t', 'integer', 'number',
    'str', 'i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'isize', 'usize',
    'f32', 'f64', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t',
    'uint32_t', 'uint64_t'
]);

// 这些词后面的名字加括号，是在调用，例如 return foo(、new foo(、if foo(
const CALL_KEYWORDS = new Set([
    'return', 'if', 'while', 'for', 'switch', 'case', 'throw', 'new', 'await',
    'yield', 'sizeof', 'typeof', 'delete', 'else', 'elif', 'elsif', 'elseif',
    'do', 'catch', 'unless', 'when', 'assert', 'require', 'and', 'or', 'not',
    'in', 'of', 'as', 'is', 'with', 'from', 'go', 'defer', 'select', 'default',
    'then', 'echo', 'instanceof', 'keyof'
]);

// 参数列表结束后，这些词说明这是定义而不是调用，例如 foo() const、foo() override
const DEFINITION_TRAIL_WORDS = new Set([
    'const', 'volatile', 'override', 'final', 'noexcept', 'throw', 'mutable',
    'try', 'abstract', 'virtual'
]);

type CallContext = 'call' | 'definition' | 'ambiguous';

// 名字后面是不是调用括号。允许空白、可选的 ?.，以及 foo<int>( 这种类型参数
function indexOfCallParen(afterText: string): number {
    let i = skipSpaces(afterText, 0);
    if (afterText.startsWith('?.', i)) {
        i = skipSpaces(afterText, i + 2);
        return afterText[i] === '(' ? i : -1;
    }
    // Rust 的 foo::<T>()
    if (afterText.startsWith('::', i)) {
        i = skipSpaces(afterText, i + 2);
    }
    if (afterText[i] === '<') {
        // <=、<<、<- 是运算符，不是类型参数
        if (afterText.startsWith('<=', i) || afterText.startsWith('<<', i) || afterText.startsWith('<-', i)) {
            return -1;
        }
        const end = skipBalancedGroup(afterText, i, '<', '>');
        if (end < 0) {
            return -1;
        }
        i = skipSpaces(afterText, end);
    }
    return afterText[i] === '(' ? i : -1;
}

// 参数列表右边如果是函数体、返回类型或 = 0 / = default，这一行是定义或声明
function hasDefinitionTail(afterText: string, parenAt: number, filePath: string): boolean {
    const end = skipBalancedGroup(afterText, parenAt, '(', ')');
    // 括号没在这一行里结束时，区分不了跨行的定义和调用，留给前面的关键字去判断
    if (end < 0) {
        return false;
    }
    let i = end;
    const comments = lineCommentPrefixes(filePath);
    while (i < afterText.length) {
        if (isWhitespace(afterText[i])) {
            i++;
            continue;
        }
        if (afterText.startsWith('/*', i)) {
            const close = afterText.indexOf('*/', i + 2);
            if (close < 0) {
                return false;
            }
            i = close + 2;
            continue;
        }
        if (comments.some(prefix => afterText.startsWith(prefix, i))) {
            return false;
        }
        break;
    }
    if (i >= afterText.length) {
        return false;
    }
    if (afterText[i] === '{') {
        return true;
    }
    // foo(): void、构造函数的 foo() : base。三元运算的冒号前面会有 ?，不会走到这里
    if (afterText[i] === ':' && !afterText.startsWith('::', i)) {
        return true;
    }
    if (afterText.startsWith('->', i) || afterText[i] === '&') {
        return true;
    }
    if (afterText[i] === '=') {
        // 纯虚函数 foo() = 0，以及 = default / = delete
        return /^(0|default|delete)\b/u.test(afterText.slice(i + 1).trimStart());
    }
    const word = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(afterText.slice(i));
    return !!word && DEFINITION_TRAIL_WORDS.has(word[0].toLowerCase());
}

// 名字左边是调用、定义，还是行首这种两边都可能的位置
function classifyPreceding(beforeText: string): CallContext {
    let end = beforeText.length;
    const back = (): CallContext => {
        while (end > 0 && isWhitespace(beforeText[end - 1])) {
            end--;
        }
        while (end >= 2 && beforeText[end - 2] === '*' && beforeText[end - 1] === '/') {
            const start = beforeText.lastIndexOf('/*', end - 2);
            end = start < 0 ? 0 : start;
            while (end > 0 && isWhitespace(beforeText[end - 1])) {
                end--;
            }
        }
        if (end === 0) {
            return 'ambiguous';
        }
        if (beforeText.endsWith('?.', end) || beforeText.endsWith('->', end)) {
            return 'call';
        }
        if (beforeText.endsWith('::', end)) {
            end -= 2;
            while (end > 0 && isIdentifierChar(beforeText[end - 1])) {
                end--;
            }
            return back();
        }
        if (beforeText[end - 1] === '.') {
            return 'call';
        }
        // PHP 的 $foo()，$ 不算名字的一部分，但这里确实是在调用
        if (beforeText[end - 1] === '$') {
            return 'call';
        }
        if (isIdentifierChar(beforeText[end - 1])) {
            let start = end;
            while (start > 0 && isIdentifierChar(beforeText[start - 1])) {
                start--;
            }
            const word = beforeText.slice(start, end).toLowerCase();
            if (DEFINITION_KEYWORDS.has(word)) {
                return 'definition';
            }
            if (CALL_KEYWORDS.has(word)) {
                return 'call';
            }
            if (DECLARATION_MODIFIERS.has(word) || TYPE_KEYWORDS.has(word)) {
                return 'definition';
            }
            // 剩下的标识符多半是返回类型，例如 MyType foo(
            return 'definition';
        }
        const ch = beforeText[end - 1];
        if (ch === ')') {
            // Go 的 func (s *T) Name(。只认紧挨着名字的那一对接收者括号，避免 if (func) foo( 被当成定义
            if (/\b(?:func|function)\s*\([^()]*\)\s*$/u.test(beforeText.slice(0, end))) {
                return 'definition';
            }
            return 'call';
        }
        if (ch === '>') {
            // x > foo( 是比较；vector<int> foo( 的 > 紧挨着类型，是声明
            if (end >= 2 && (beforeText[end - 2] === '=' || beforeText[end - 2] === '-' || isWhitespace(beforeText[end - 2]))) {
                return 'call';
            }
            return 'definition';
        }
        if (ch === '*' || ch === '&') {
            // *foo() 是调用函数指针；int *foo(、function* foo( 是声明
            let j = end;
            while (j > 0 && (beforeText[j - 1] === '*' || beforeText[j - 1] === '&')) {
                j--;
            }
            const saved = end;
            end = j;
            const inner = back();
            end = saved;
            return inner === 'definition' ? 'definition' : 'call';
        }
        if (ch === '#') {
            end--;
            return back();
        }
        return 'call';
    };
    return back();
}

/**
 * 这一处是不是函数或方法调用。
 * 名字后面要有调用括号（可以隔着空白或类型参数）。
 * 定义和声明不算调用，例如 void foo(、function foo(、foo() {、func (s *T) foo(。
 * obj.foo(、p->foo(、return foo(、foo() 算调用。
 * 字符串和注释里的同名文本不算调用。
 */
export function isFunctionCall(beforeText: string, afterText: string, filePath = ''): boolean {
    const prefix = scanPrefix(beforeText, lineCommentPrefixes(filePath));
    if (prefix.inString || prefix.inComment) {
        return false;
    }
    const parenAt = indexOfCallParen(afterText);
    if (parenAt < 0) {
        return false;
    }
    const preceding = classifyPreceding(beforeText);
    if (preceding === 'call') {
        return true;
    }
    if (preceding === 'definition') {
        return false;
    }
    // 行首或 Foo::bar 这种位置：foo(); 是调用，foo() { 是定义
    return !hasDefinitionTail(afterText, parenAt, filePath);
}

// 同一行可能多次出现被搜索的名字。结果列表一行只显示一处：优先写操作，其次函数调用
export function chooseMatchRange(
    detector: WriteOperationDetector,
    content: string,
    ranges: { start: number; end: number }[],
    filePath: string
): { start: number; end: number; isWrite: boolean; isCall: boolean } | undefined {
    if (ranges.length === 0) {
        return undefined;
    }
    const describe = (range: { start: number; end: number }) => {
        const before = content.slice(0, range.start);
        const after = content.slice(range.end);
        const isWrite = detector.isWriteOperation(after, before, filePath);
        const isCall = !isWrite && isFunctionCall(before, after, filePath);
        return { range, isWrite, isCall };
    };
    let chosen = describe(ranges[0]);
    if (!chosen.isWrite) {
        for (let i = 1; i < ranges.length; i++) {
            const next = describe(ranges[i]);
            if (next.isWrite) {
                chosen = next;
                break;
            }
            if (!chosen.isCall && next.isCall) {
                chosen = next;
            }
        }
    }
    return {
        start: chosen.range.start,
        end: chosen.range.end,
        isWrite: chosen.isWrite,
        isCall: chosen.isCall
    };
}
