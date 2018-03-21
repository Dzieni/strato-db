module.exports = {
	env: {
		browser: true,
		commonjs: true,
		es6: true,
		node: true,
	},
	parser: 'babel-eslint',
	plugins: ['jest', 'import', 'promise', 'unicorn'],
	extends: [
		'eslint:recommended',
		'plugin:jest/recommended',
		'plugin:import/errors',
		'plugin:import/warnings',
		'plugin:promise/recommended',
		'plugin:unicorn/recommended',
		'xo/esnext',
	],
	rules: {
		// the good stuff
		'constructor-super': 1,
		'import/first': 1,
		// Would make this an error but it can't handle * exports
		'import/named': 1,
		// our webpack nodeRequire trick is not a package
		'import/no-unresolved': [2, {ignore: ['nodeRequire']}],
		'no-const-assign': 1,
		'no-implicit-coercion': [2, {allow: ['!!']}],
		'no-this-before-super': 1,
		'no-unreachable': 1,
		'valid-typeof': 1,
		eqeqeq: [2, 'allow-null'],

		// ignore everything handled by prettier
		'arrow-parens': 0,
		'babel/arrow-parens': 0,
		'brace-style': 0,
		'capitalized-comments': 0,
		'comma-dangle': 0,
		'function-paren-newline': 0,
		'max-statements-per-line': 0,
		'no-eq-null': 0,
		'no-extra-semi': 0,
		'no-mixed-operators': 0,
		'no-multi-spaces': 0,
		'no-trailing-spaces': 0,
		'object-curly-spacing': 0,
		'one-var': 0,
		'operator-linebreak': 0,
		'padded-blocks': 0,
		'prefer-template': 0,
		'promise/param-names': 0,
		'quote-props': 0,
		'space-before-function-paren': 0,
		'space-in-parens': 0,
		'space-infix-ops': 0,
		'unicorn/explicit-length-check': 0,
		'unicorn/filename-case': 0,
		curly: 0,
		indent: 0,
		quotes: 0,
		semi: 0,
	},
}
