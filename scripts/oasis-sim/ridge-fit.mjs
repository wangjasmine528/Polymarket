// @ts-check

/**
 * Gauss–Jordan invert (n×n). Throws if singular.
 * @param {number[][]} A0
 * @returns {number[][]}
 */
export function invertMatrix(A0) {
  const n = A0.length;
  const A = A0.map((row) => [...row]);
  const I = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (Math.abs(A[piv][col]) < 1e-12) throw new Error('singular matrix');
    if (piv !== col) {
      [A[col], A[piv]] = [A[piv], A[col]];
      [I[col], I[piv]] = [I[piv], I[col]];
    }
    const div = A[col][col];
    for (let j = 0; j < n; j += 1) {
      A[col][j] /= div;
      I[col][j] /= div;
    }
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = A[r][col];
      if (Math.abs(f) < 1e-15) continue;
      for (let j = 0; j < n; j += 1) {
        A[r][j] -= f * A[col][j];
        I[r][j] -= f * I[col][j];
      }
    }
  }
  return I;
}

/**
 * Ridge: minimize ||y - Xβ||² + λ||β||² (no penalty on intercept: shrink only slopes).
 * X columns: [1, base, esc, cont, frag]
 * @param {number[][]} X
 * @param {number[]} y
 * @param {number} lambda
 * @returns {{ coef: number[]; trainMse: number }}
 */
export function ridgeFitWithIntercept(X, y, lambda) {
  const n = X.length;
  const p = X[0].length;
  /** @type {number[][]} */
  const XtX = Array.from({ length: p }, () => Array.from({ length: p }, () => 0));
  /** @type {number[]} */
  const Xty = Array.from({ length: p }, () => 0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < p; j += 1) {
      Xty[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k += 1) {
        XtX[j][k] += X[i][j] * X[i][k];
      }
    }
  }
  for (let j = 1; j < p; j += 1) {
    XtX[j][j] += lambda;
  }

  const invXtX = invertMatrix(XtX);
  /** @type {number[]} */
  const coef = Array.from({ length: p }, () => 0);
  for (let j = 0; j < p; j += 1) {
    for (let k = 0; k < p; k += 1) {
      coef[j] += invXtX[j][k] * Xty[k];
    }
  }

  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    let pred = 0;
    for (let j = 0; j < p; j += 1) pred += X[i][j] * coef[j];
    const d = y[i] - pred;
    sse += d * d;
  }
  return { coef, trainMse: sse / n };
}
