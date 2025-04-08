import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// 定义接口
interface PatternConfig {
    pattern: string;
    description: string;
    examples: string[];
}

interface WritePatterns {
    [key: string]: {
        operators: string[];
        methods: string[];
        excludeOperators?: string[];
    };
}

interface SearchResult {
    file: string;
    fileName: string;
    line: number;
    lineContent: string;
    isWrite: boolean;
}

// 写操作检测类
class WriteOperationDetector {
    private patterns: WritePatterns;
    private patternCache: Map<string, RegExp[]> = new Map();

    constructor() {
        this.patterns = this.loadPatternsFromConfig();
    }

    private loadPatternsFromConfig(): WritePatterns {
        const config = vscode.workspace.getConfiguration('searchhighlight');
        return config.get<WritePatterns>('patterns') || {};
    }

    public reloadPatterns(): void {
        this.patterns = this.loadPatternsFromConfig();
        this.patternCache.clear();
    }

    private getFileLanguage(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        switch (ext) {
            case '.py':
                return 'python';
            case '.js':
            case '.ts':
            case '.jsx':
            case '.tsx':
                return 'javascript';
            case '.java':
                return 'java';
            case '.cpp':
            case '.hpp':
            case '.cc':
            case '.h':
                return 'cpp';
            default:
                return 'common';
        }
    }

    public isWriteOperation(filePath: string, lineText: string): boolean {
        const patterns = this.patterns.common;
        
        if (!patterns || !lineText) {
            return false;
        }

        // 获取第一个非空白字符
        const firstNonWhitespace = lineText.trim()[0];
        if (!firstNonWhitespace) {
            return false;
        }

        // 1. 如果以.开头，检查是否是写操作方法
        if (firstNonWhitespace === '.') {
            return patterns.methods.some(method => 
                lineText.trim().startsWith(method));
        }

        // 2. 检查第一个非空白字符是否是操作符
        if (patterns.operators.includes(firstNonWhitespace)) {
            // 排除比较操作符
            return !patterns.excludeOperators?.some(op => 
                lineText.trim().startsWith(op));
        }

        // 3. 如果第一个字符既不是.也不是操作符，返回false
        return false;
    }
}

// 创建写操作检测器实例
const writeDetector = new WriteOperationDetector();

class SearchResultsView {
    private static currentProvider: SearchResultsProvider | undefined;

    public static createOrShow(context: vscode.ExtensionContext) {
        if (!this.currentProvider) {
            this.currentProvider = new SearchResultsProvider(context.extensionUri);
        }
        return this.currentProvider;
    }

    public static dispose() {
        if (this.currentProvider) {
            this.currentProvider.dispose();
            this.currentProvider = undefined;
        }
    }
}

class SearchResultsProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _currentSearchResults?: { results: SearchResult[]; searchText: string; };

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

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
                    break;
            }
        });
    }

    public showResults(results: SearchResult[], searchText: string) {
        if (this._view) {
            const config = vscode.workspace.getConfiguration('searchhighlight');
            const readColor = config.get<string>('colors.read');
            const writeColor = config.get<string>('colors.write');

            this._currentSearchResults = { results, searchText };
            this._view.show(true);
            this._view.webview.postMessage({ 
                type: 'results', 
                results, 
                searchText,
                colors: {
                    read: readColor,
                    write: writeColor
                }
            });
        }
    }

    public updateCurrentResults() {
        if (this._currentSearchResults) {
            this.showResults(this._currentSearchResults.results, this._currentSearchResults.searchText);
        }
    }

    private _getHtmlForWebview() {
        const webviewPath = path.join(this._extensionUri.fsPath, 'src', 'webview.html');
        let html = fs.readFileSync(webviewPath, 'utf8');
        return html;
    }

    public dispose() {
        // 清理资源
    }
}

export function activate(context: vscode.ExtensionContext) {
    const searchResultsProvider = new SearchResultsProvider(context.extensionUri);
    const viewDisposable = vscode.window.registerWebviewViewProvider('searchHighlightResults', searchResultsProvider);
    context.subscriptions.push(viewDisposable);

    // 修改确保视图可见的函数
    async function ensureViewIsVisible() {
        // 只使用一个命令打开视图容器即可
        await vscode.commands.executeCommand('workbench.view.extension.search-highlight');
    }

    // 注册 focus 命令
    context.subscriptions.push(
        vscode.commands.registerCommand('searchhighlight.focus', () => {
            return ensureViewIsVisible();
        })
    );

    // 监听配置变更
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('searchhighlight.patterns') ||
                e.affectsConfiguration('searchhighlight.colors')) {
                writeDetector.reloadPatterns();
                searchResultsProvider.updateCurrentResults();
                vscode.window.showInformationMessage('搜索高亮配置已更新');
            }
        })
    );

    let disposable = vscode.commands.registerCommand('searchhighlight.searchAndHighlight', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const selection = editor.selection;
        const searchText = editor.document.getText(selection);
        
        if (!searchText) {
            vscode.window.showInformationMessage('请先选择要搜索的文本');
            return;
        }

        // 确保搜索结果视图是可见的
        await ensureViewIsVisible();

        // 显示进度提示
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `搜索 "${searchText}"`,
            cancellable: true
        }, async (progress) => {
            const results: SearchResult[] = [];
            
            // 从配置中获取排除目录
            const config = vscode.workspace.getConfiguration('searchhighlight');
            const excludeDirs = config.get<string[]>('excludePatterns') || [];
            const excludePattern = `**/{${excludeDirs.join(',')}}/**`;
            
            // 在工作区中搜索文件，添加排除模式
            const files = await vscode.workspace.findFiles(
                '**/*.{js,ts,jsx,tsx,vue,java,py,cpp,c,cs,go,rs,php}',
                excludePattern
            );
            const totalFiles = files.length;
            let processedFiles = 0;

            for (const file of files) {
                try {
                    const document = await vscode.workspace.openTextDocument(file);
                    const fileName = path.basename(file.fsPath);
                    
                    for (let i = 0; i < document.lineCount; i++) {
                        const line = document.lineAt(i);
                        const lineText = line.text;
                        
                        if (lineText.includes(searchText)) {
                            const searchIndex = lineText.indexOf(searchText);
                            const textAfterSearch = lineText.substring(searchIndex + searchText.length);
                            const isWriteOperation = writeDetector.isWriteOperation(file.fsPath, textAfterSearch);

                            results.push({
                                file: file.fsPath,
                                fileName: fileName,
                                line: i,
                                lineContent: lineText,
                                isWrite: isWriteOperation
                            });
                        }
                    }
                } catch (err) {
                    console.error(`Error processing file ${file.fsPath}:`, err);
                }

                processedFiles++;
                progress.report({
                    message: `已处理 ${processedFiles}/${totalFiles} 个文件`,
                    increment: (100 / totalFiles)
                });
            }

            // 更新搜索结果视图
            searchResultsProvider.showResults(results, searchText);
            
            // 显示统计信息
            const writeCount = results.filter(r => r.isWrite).length;
            const readCount = results.length - writeCount;
            //vscode.window.showInformationMessage(`找到 ${results.length} 处匹配：${readCount} 处读操作，${writeCount} 处写操作`);
        });
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {
    SearchResultsView.dispose();
}
