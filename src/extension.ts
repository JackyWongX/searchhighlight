import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// 写操作的关键字
const writeOperations = [
    '=', '+=', '-=', '*=', '/=', '%=', '++', '--',
    'append', 'add', 'insert', 'push',
    'remove', 'delete', 'erase', 'clear',
    'set', 'update', 'modify', 'replace'
];

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

    public showResults(results: any[], searchText: string) {
        if (this._view) {
            this._view.show(true);
            this._view.webview.postMessage({ type: 'results', results, searchText });
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
    // 注册 WebView 视图提供者
    const searchResultsProvider = new SearchResultsProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('searchHighlightResults', searchResultsProvider)
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

        // 显示进度提示
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `搜索 "${searchText}"`,
            cancellable: true
        }, async (progress) => {
            const results: Array<{
                file: string;
                line: number;
                lineContent: string;
                isWrite: boolean;
            }> = [];
            
            // 在工作区中搜索文件
            const files = await vscode.workspace.findFiles('**/*.{js,ts,jsx,tsx,vue,java,py,cpp,c,cs,go,rs,php}');
            const totalFiles = files.length;
            let processedFiles = 0;

            for (const file of files) {
                try {
                    const document = await vscode.workspace.openTextDocument(file);
                    for (let i = 0; i < document.lineCount; i++) {
                        const line = document.lineAt(i);
                        const lineText = line.text;
                        
                        if (lineText.includes(searchText)) {
                            // 检查是否包含写操作关键字
                            const isWriteOperation = writeOperations.some(op => 
                                lineText.includes(op) && 
                                (lineText.includes(' ' + op) || 
                                 lineText.includes(op + ' ') || 
                                 lineText.includes(op + '(') ||
                                 op === '=' || op === '+=' || op === '-=' || 
                                 op === '*=' || op === '/=' || op === '%=')
                            );

                            results.push({
                                file: file.fsPath,
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
            vscode.window.showInformationMessage(
                `找到 ${results.length} 处匹配：${readCount} 处读操作，${writeCount} 处写操作`
            );
        });
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {
    SearchResultsView.dispose();
}
