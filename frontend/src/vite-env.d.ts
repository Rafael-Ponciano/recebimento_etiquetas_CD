interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface PywebviewSalvarResposta {
  ok: boolean;
  cancelado?: boolean;
  caminho?: string;
  erro?: string;
}

interface Window {
  pywebview?: {
    api?: {
      salvar_arquivo?: (
        nomeArquivo: string,
        conteudoB64: string
      ) => Promise<PywebviewSalvarResposta>;
    };
  };
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileSystemFileHandle>;
}

