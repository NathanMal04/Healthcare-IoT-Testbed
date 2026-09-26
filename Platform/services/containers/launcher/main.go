// Command launcher is the entrypoint of every script image.
//
// It is a static binary so it runs in any image, including L3 images built
// from a user's own Dockerfile. The job has no AWS credentials: everything it
// reads or writes goes through the run's manifest service, which hands out
// short-lived presigned S3 URLs.
//
//  1. POST {MANIFEST_URL}/manifest       -> this job's work units and input URLs
//  2. for each unit not already done:
//     download its inputs (SHA-256 checked), run PLATFORM_COMMAND once,
//     then POST /outputs/presign, upload each output to S3, POST /outputs/complete
//  3. on SIGTERM (Spot interruption) stop the script and exit 143; finished
//     units are already recorded, so the retried job skips them
//
// A script that exits non-zero fails only its unit; the launcher records the
// failure and moves on. The launcher itself exits non-zero only for
// infrastructure errors, so Batch retries the job.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

type input struct {
	ArtifactID       string   `json:"artifactId"`
	Name             string   `json:"name"`
	OriginalFilename string   `json:"originalFilename"`
	Type             string   `json:"type"`
	Sha256           string   `json:"sha256"`
	SizeBytes        int64    `json:"sizeBytes"`
	Tags             []string `json:"tags"`
	URL              string   `json:"url,omitempty"`
	Path             string   `json:"path,omitempty"`
}

type unit struct {
	UnitID string  `json:"unitId"`
	Key    string  `json:"key"`
	Done   bool    `json:"done"`
	Inputs []input `json:"inputs"`
}

type limits struct {
	MaxFilesPerUnit int   `json:"maxFilesPerUnit"`
	MaxBytesPerUnit int64 `json:"maxBytesPerUnit"`
	MaxBytesPerFile int64 `json:"maxBytesPerFile"`
}

type manifest struct {
	RunID      string `json:"runId"`
	ChildIndex int    `json:"childIndex"`
	Units      []unit `json:"units"`
	Limits     limits `json:"limits"`
}

type outputFile struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	Sha256    string `json:"sha256"`
	local     string
}

type presignedOutput struct {
	Path       string `json:"path"`
	ArtifactID string `json:"artifactId"`
	AttemptID  string `json:"attemptId"`
	Upload     struct {
		URL    string            `json:"url"`
		Fields map[string]string `json:"fields"`
	} `json:"upload"`
}

type config struct {
	manifestURL string
	runID       string
	token       string
	childIndex  int
	command     []string
	workDir     string
}

var (
	httpClient  = &http.Client{Timeout: 10 * time.Minute}
	terminating atomic.Bool
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		fatal("configuration: %v", err)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-signals
		terminating.Store(true)
		logf("received termination signal; stopping after the current script exits")
	}()

	var m manifest
	if err := callAPI(cfg, "/manifest", map[string]any{"runId": cfg.runID, "childIndex": cfg.childIndex}, &m); err != nil {
		fatal("fetching manifest: %v", err)
	}
	logf("run %s job %d: %d work unit(s)", cfg.runID, cfg.childIndex, len(m.Units))

	for i, u := range m.Units {
		if terminating.Load() {
			os.Exit(143)
		}
		if u.Done {
			logf("unit %q already done, skipping", u.Key)
			continue
		}
		if err := processUnit(cfg, m.Limits, i, u); err != nil {
			if terminating.Load() {
				os.Exit(143)
			}
			fatal("unit %q: %v", u.Key, err)
		}
	}
	logf("all work units finished")
}

func loadConfig() (config, error) {
	cfg := config{
		manifestURL: strings.TrimRight(os.Getenv("MANIFEST_URL"), "/"),
		runID:       os.Getenv("RUN_ID"),
		token:       os.Getenv("RUN_TOKEN"),
		workDir:     os.Getenv("PLATFORM_WORK_DIR"),
	}
	if cfg.workDir == "" {
		cfg.workDir = "/work"
	}
	if cfg.manifestURL == "" || cfg.runID == "" || cfg.token == "" {
		return cfg, errors.New("MANIFEST_URL, RUN_ID and RUN_TOKEN must be set")
	}
	if idx := os.Getenv("AWS_BATCH_JOB_ARRAY_INDEX"); idx != "" {
		n, err := strconv.Atoi(idx)
		if err != nil {
			return cfg, fmt.Errorf("bad AWS_BATCH_JOB_ARRAY_INDEX %q", idx)
		}
		cfg.childIndex = n
	}
	if err := json.Unmarshal([]byte(os.Getenv("PLATFORM_COMMAND")), &cfg.command); err != nil || len(cfg.command) == 0 {
		return cfg, errors.New("PLATFORM_COMMAND must be a non-empty JSON array")
	}
	return cfg, nil
}

// processUnit runs one work unit end to end. It returns an error only for
// infrastructure failures; a failing script is recorded and returns nil.
func processUnit(cfg config, lim limits, index int, u unit) error {
	unitDir := filepath.Join(cfg.workDir, "units", strconv.Itoa(index))
	inputsDir := filepath.Join(unitDir, "inputs")
	outputDir := filepath.Join(unitDir, "outputs")
	if err := os.RemoveAll(unitDir); err != nil {
		return err
	}
	if err := os.MkdirAll(outputDir, 0o777); err != nil {
		return err
	}

	for i := range u.Inputs {
		in := &u.Inputs[i]
		dir := filepath.Join(inputsDir, in.ArtifactID)
		if err := os.MkdirAll(dir, 0o777); err != nil {
			return err
		}
		in.Path = filepath.Join(dir, safeName(in.Name))
		if err := download(in.URL, in.Path, in.Sha256); err != nil {
			return fmt.Errorf("downloading %s: %w", in.Name, err)
		}
		in.URL = ""
	}

	manifestPath := filepath.Join(unitDir, "unit.json")
	data, _ := json.Marshal(map[string]any{"unitId": u.UnitID, "key": u.Key, "inputs": u.Inputs})
	if err := os.WriteFile(manifestPath, data, 0o644); err != nil {
		return err
	}

	env := scriptEnv()
	env = append(env,
		"PLATFORM_MANIFEST="+manifestPath,
		"PLATFORM_INPUTS_DIR="+inputsDir,
		"PLATFORM_OUTPUT_DIR="+outputDir,
		"PLATFORM_GROUP_KEY="+u.Key,
	)
	if len(u.Inputs) == 1 {
		env = append(env, "PLATFORM_INPUT="+u.Inputs[0].Path)
	}

	logf("unit %q: running %s on %d input(s)", u.Key, cfg.command[0], len(u.Inputs))
	exitCode, stderrTail, err := runScript(cfg.command, env)
	if err != nil {
		return err
	}
	if terminating.Load() {
		return errors.New("interrupted")
	}
	if exitCode != 0 {
		logf("unit %q: script exited %d", u.Key, exitCode)
		return complete(cfg, u, "failed", exitCode, stderrTail, nil)
	}

	outputs, limitErr, err := collectOutputs(outputDir, lim)
	if err != nil {
		return err
	}
	if limitErr != "" {
		logf("unit %q: %s", u.Key, limitErr)
		return complete(cfg, u, "failed", 0, limitErr, nil)
	}

	var done []map[string]string
	for start := 0; start < len(outputs); start += 100 {
		end := min(start+100, len(outputs))
		batch := outputs[start:end]
		var resp struct {
			Files []presignedOutput `json:"files"`
		}
		err := callAPI(cfg, "/outputs/presign", map[string]any{
			"runId": cfg.runID, "childIndex": cfg.childIndex, "unitId": u.UnitID, "files": batch,
			"attempt": os.Getenv("AWS_BATCH_JOB_ATTEMPT"),
		}, &resp)
		if err != nil {
			return fmt.Errorf("registering outputs: %w", err)
		}
		byPath := map[string]outputFile{}
		for _, o := range batch {
			byPath[o.Path] = o
		}
		for _, p := range resp.Files {
			o, ok := byPath[p.Path]
			if !ok {
				return fmt.Errorf("manifest service returned unknown output %q", p.Path)
			}
			if err := uploadForm(p.Upload.URL, p.Upload.Fields, o.local, o.SizeBytes); err != nil {
				return fmt.Errorf("uploading %s: %w", o.Path, err)
			}
			done = append(done, map[string]string{"artifactId": p.ArtifactID, "attemptId": p.AttemptID})
		}
	}

	logf("unit %q: %d output(s)", u.Key, len(done))
	return complete(cfg, u, "succeeded", 0, "", done)
}

func complete(cfg config, u unit, status string, exitCode int, reason string, outputs []map[string]string) error {
	if outputs == nil {
		outputs = []map[string]string{}
	}
	return callAPI(cfg, "/outputs/complete", map[string]any{
		"runId": cfg.runID, "childIndex": cfg.childIndex, "unitId": u.UnitID,
		"status": status, "exitCode": exitCode, "error": reason, "outputs": outputs,
	}, nil)
}

// scriptEnv is the launcher's environment without the run token. The script
// runs in the same container and could still find it, but it has no reason
// to see it.
func scriptEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "RUN_TOKEN=") || strings.HasPrefix(kv, "PLATFORM_COMMAND=") {
			continue
		}
		env = append(env, kv)
	}
	return env
}

// runScript runs the command in its own process group, forwards a
// termination signal to it, and keeps the last 4 KB of stderr.
func runScript(command []string, env []string) (int, string, error) {
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Env = env
	cmd.Stdout = os.Stdout
	tail := &tailBuffer{max: 4096}
	cmd.Stderr = io.MultiWriter(os.Stderr, tail)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	if err := cmd.Start(); err != nil {
		// A command that can't start is the script's problem, not ours.
		return 127, fmt.Sprintf("could not start %s: %v", command[0], err), nil
	}

	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(200 * time.Millisecond):
				if terminating.Load() {
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
					return
				}
			}
		}
	}()
	err := cmd.Wait()
	close(stop)

	if err == nil {
		return 0, tail.String(), nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		code := exitErr.ExitCode()
		if code < 0 {
			code = 128 + int(syscall.SIGKILL)
		}
		return code, tail.String(), nil
	}
	return 0, "", err
}

func collectOutputs(dir string, lim limits) ([]outputFile, string, error) {
	var files []outputFile
	var total int64
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.Type().IsRegular() {
			return nil // directories, and symlinks, which could point outside the folder
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		sum, size, err := hashFile(path)
		if err != nil {
			return err
		}
		total += size
		files = append(files, outputFile{Path: filepath.ToSlash(rel), SizeBytes: size, Sha256: sum, local: path})
		return nil
	})
	if err != nil {
		return nil, "", err
	}
	for _, f := range files {
		if f.SizeBytes == 0 {
			return nil, fmt.Sprintf("output %s is empty; empty files can't be stored", f.Path), nil
		}
		if lim.MaxBytesPerFile > 0 && f.SizeBytes > lim.MaxBytesPerFile {
			return nil, fmt.Sprintf("output %s is larger than %d bytes", f.Path, lim.MaxBytesPerFile), nil
		}
	}
	if lim.MaxFilesPerUnit > 0 && len(files) > lim.MaxFilesPerUnit {
		return nil, fmt.Sprintf("%d output files exceed the limit of %d", len(files), lim.MaxFilesPerUnit), nil
	}
	if lim.MaxBytesPerUnit > 0 && total > lim.MaxBytesPerUnit {
		return nil, fmt.Sprintf("outputs total %d bytes, over the limit of %d", total, lim.MaxBytesPerUnit), nil
	}
	return files, "", nil
}

// --- HTTP ---------------------------------------------------------------------

func callAPI(cfg config, path string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return retry(func() (bool, error) {
		req, err := http.NewRequest(http.MethodPost, cfg.manifestURL+path, bytes.NewReader(payload))
		if err != nil {
			return false, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Run-Token", cfg.token)
		resp, err := httpClient.Do(req)
		if err != nil {
			return true, err
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		if resp.StatusCode >= 500 || resp.StatusCode == 429 {
			return true, fmt.Errorf("%s: HTTP %d: %s", path, resp.StatusCode, snippet(data))
		}
		if resp.StatusCode >= 300 {
			return false, fmt.Errorf("%s: HTTP %d: %s", path, resp.StatusCode, snippet(data))
		}
		if out != nil {
			return false, json.Unmarshal(data, out)
		}
		return false, nil
	})
}

func download(url, dest, wantSha string) error {
	return retry(func() (bool, error) {
		resp, err := httpClient.Get(url)
		if err != nil {
			return true, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return resp.StatusCode >= 500, fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		f, err := os.Create(dest)
		if err != nil {
			return false, err
		}
		h := sha256.New()
		_, err = io.Copy(io.MultiWriter(f, h), resp.Body)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return true, err
		}
		if got := hex.EncodeToString(h.Sum(nil)); got != wantSha {
			return true, fmt.Errorf("SHA-256 mismatch: got %s", got)
		}
		return false, nil
	})
}

// uploadForm POSTs a file to S3 with a presigned POST policy. S3 needs a
// Content-Length, so the multipart body is streamed with a known size
// instead of being buffered.
func uploadForm(url string, fields map[string]string, path string, size int64) error {
	return retry(func() (bool, error) {
		var head bytes.Buffer
		mw := multipart.NewWriter(&head)
		for k, v := range fields {
			if err := mw.WriteField(k, v); err != nil {
				return false, err
			}
		}
		// The file must be the last field; S3 ignores anything after it.
		h := make(textproto.MIMEHeader)
		h.Set("Content-Disposition", `form-data; name="file"; filename="output"`)
		h.Set("Content-Type", "application/octet-stream")
		if _, err := mw.CreatePart(h); err != nil {
			return false, err
		}
		tail := []byte("\r\n--" + mw.Boundary() + "--\r\n")

		f, err := os.Open(path)
		if err != nil {
			return false, err
		}
		defer f.Close()

		req, err := http.NewRequest(http.MethodPost, url, io.MultiReader(bytes.NewReader(head.Bytes()), f, bytes.NewReader(tail)))
		if err != nil {
			return false, err
		}
		req.ContentLength = int64(head.Len()) + size + int64(len(tail))
		req.Header.Set("Content-Type", mw.FormDataContentType())
		resp, err := httpClient.Do(req)
		if err != nil {
			return true, err
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if resp.StatusCode >= 300 {
			return resp.StatusCode >= 500, fmt.Errorf("S3 HTTP %d: %s", resp.StatusCode, snippet(data))
		}
		return false, nil
	})
}

// retry runs fn up to 4 times with backoff while it reports a retryable error.
func retry(fn func() (retryable bool, err error)) error {
	var err error
	for attempt := 1; attempt <= 4; attempt++ {
		var again bool
		again, err = fn()
		if err == nil || !again || terminating.Load() {
			return err
		}
		time.Sleep(time.Duration(attempt*attempt) * time.Second)
	}
	return err
}

// --- Helpers ------------------------------------------------------------------

func hashFile(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), n, err
}

func safeName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if name == "." || name == "/" || name == ".." || name == "" {
		return "input"
	}
	return name
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

type tailBuffer struct {
	max int
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string { return string(t.buf) }

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[launcher] "+format+"\n", args...)
}

func fatal(format string, args ...any) {
	logf(format, args...)
	os.Exit(1)
}
