function makeExpressInstance(module: NgModuleFactory<any>) {
  const app = express();
  app.engine('html', ngExpressEngine({
    bootstrap: module
  }));

  app.set('view engine', 'html');

  app.get('*', (req: express.Request, res: express.Response) => {
    // TODO: how to render without express trying to lookup a view?
    (res as any).render(null, {
      req,
      res,
      document: '<root></root>'
    });
  });
  return app;
}

describe('test runner', () => {
  it('can run a test', () => {
    expect(true).toBe(true);
  });
  xit('can render a simple app', (done) => {
    const template = `some template: ${new Date()}`;
    const appModule = makeTestingModule(template);
    const expressApp = makeExpressInstance(appModule);
    expressApp.listen(3000, () => {
      axios.get('http://localhost:3000')
      .then(res => res.data)
      .then(html => {
        expect(html).toContain(template);
        done();
      });
    });
  });
});
